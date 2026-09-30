# PhiTeX Preview for Overleaf (experimental)

A Chrome extension (Manifest V3) that shows a live, incremental
[PhiTeX](../PhiTeX) preview **next to** Overleaf's own PDF. It is not a
replacement. PhiTeX compiles TeX to SSA and keeps it up to date on every
edit. The extension runs it in the browser as WebAssembly, so each keystroke
rebuilds only the chunks it touched, and the page on screen is repainted
first.

> **Experimental.** PhiTeX handles a subset of plain TeX and has no LaTeX
> kernel yet. On a LaTeX project the panel says so, and what it shows is not
> your document. Overleaf's PDF is the real one.

## Install (unpacked)

Requirements: the Rust toolchain pinned in `rust-toolchain.toml`, with the
`wasm32-wasip1` target (`rustup target add wasm32-wasip1`), Node ≥ 22,
bubblewrap (for `scripts/sandbox`), and a checkout of PhiTeX. `core/Cargo.toml`
points at it by path.

    scripts/sandbox --net npm ci --ignore-scripts   # typescript, @types/chrome (dev only)
    scripts/build.sh                                # wasm core + TypeScript → extension/

Then open `chrome://extensions`, turn on *Developer mode*, choose *Load
unpacked*, and pick the `extension/` directory. Open any
`https://www.overleaf.com/project/…` page and the panel appears at the bottom
right. You can drag it by its header or minimize it.

Development:

    scripts/build.sh --dev                          # also matches the mock at localhost:8123
    scripts/sandbox --net node mock/server.mjs      # mock Overleaf: http://localhost:8123/project/mock
    scripts/chrome.sh [url]                         # Chromium with the extension, DevTools on :9222
    scripts/sandbox node --test test/               # TypeScript + wasm tests
    scripts/sandbox node bench/latency.mjs          # latencies of the wasm core

Everything runs through `scripts/sandbox` (bubblewrap: this repo writable,
PhiTeX read-only, `$HOME` empty, no network unless `--net`).

## The panel

**Docked** in Overleaf's PDF pane: a **PDF | ⚡ Instant** switch sits in the PDF toolbar next to Recompile (Alt+Shift+P toggles it). In PhiTeX mode the
preview takes the place of Overleaf's viewer, which is hidden, not removed.
Its controls are Overleaf's own, markup for markup, laid out as Overleaf's
viewer does for the pane's width:
- **Full:** ⌃ ⌄, the page number, − +, and zoom %.
- **Compact:** zoom % and ⋯.

The zoom menu also holds PhiTeX's settings and timings. Where Overleaf has
its logs and download, PhiTeX shows its own: a diagnostics button with a
count badge, and PhiTeX's PDF. A ⚡ chip at the bottom right of the pane
shows each repaint's keystroke→page time. It follows Overleaf's theme (`data-theme`, `--pdf-bg`), and
Overleaf's "dark mode PDF" invert applies to it too. A tip bubble points at the switch on each load, while
Overleaf's PDF is showing, until you click "Don't show again".

**Floating window**: the fallback when Overleaf's layout isn't found, for
example when the PDF pane is closed or an upstream change moved it. It
appears only after 8 s without the pane. Drag it by its header, resize it
from the corner, or collapse it to a pill (Alt+Shift+P). Its position, size,
zoom and view are remembered.

- **Page**: the page you're looking at (‹ ›), repainted on every edit with
  `edit_view`, which paints that page first and then brings the rest to the
  fixed point.
  - **Vector** (default): PhiTeX's draw list as SVG. The text is real: you
    can select it, copy it, and find it with Ctrl+F, and it stays crisp at
    any zoom. Positions and line breaks are PhiTeX's; glyphs are the
    browser's Times, Helvetica and Courier.
  - **PNG**: PhiTeX's own raster, which draws a grey box per glyph.
- **Status chip**: pages, and a colored dot. Green: fine. Amber: partial or
  warnings. Red: errors. "partial" means some text wasn't read (out of fuel
  or unsupported).
- **Diagnostics**: one line always ("⚠ 2 ⓘ 1 · the worst"). Click it for
  the full list, a drawer over the page that never shrinks it. Click an
  entry to jump to its line in the editor (the file opens if needed).
  Examples: an open `{` at the line it opened, `$` never closed, `\def`
  without a body, `\input` of a missing file, LaTeX (unsupported),
  non-ASCII, out of fuel.
- **When a build ships nothing** (say, an unclosed `\def\x{` swallowing the
  document), the last good page stays, dimmed, with a banner saying why.
  Incomplete input never breaks the preview.
- **Footer**: keystroke→page latency, the core's time, and edits → builds.
  Click it for the breakdown (first paint, fixed point, queue, round trip,
  paint, chunks rebuilt, passes).
- **PDF**: PhiTeX's PDF (`-phitex.pdf`), made locally.
- **Debug (bug icon)**: every 5 s, the incremental state is checked against
  a fresh build of the same text (PhiTeX's invariant), and the core's copy
  of the open file against the editor's. A mismatch is shown in red.
- **Main**: guessed (a file that ends the job with `\bye`, or `main.tex`).
  Change it from the list. **Sync** fetches every doc again and diffs each
  one in.

## How it works

```
Overleaf page ─────────────────────────────────────────────┐   extension
 CodeMirror 6 EditorView                                   │
   ▲ hook.ts (page world): view.update / setState wrapped, │
   │ reads transactions' changes (UTF-16), open file name  │
   └─ window.postMessage ─▶ content script (content-main.ts: Overleaf wiring)
                             session.ts: PreviewSession (editor-agnostic)
                               edits.ts: UTF-16 → UTF-8 bytes, merge, Batch
                               one build in flight, the rest merged (backpressure)
                               diagnostics.ts: records (severity, code, file, line)
                             ── chrome.runtime port ──▶ offscreen document
                                                          └─▶ Worker: core.wasm
                                                               (PhiTeX Doc, WASI shim)
```

- **Edits**: every CodeMirror transaction (your typing, and collaborators'
  edits Overleaf applies to the open file) becomes sequential edits. They
  are merged when adjacent, converted to UTF-8 byte ranges, and sent in
  order. At most one build is in flight. What you type meanwhile merges and
  goes out as one edit when the core is free, so a fast core builds every
  keystroke and a slow one builds the last N together.
- **Files**: `GET /project/:id/entities` lists the paths. The file tree gives
  each doc's id, and `GET /project/:id/doc/:id/download` gives its text.
  Only text docs are fetched, never images. The project ZIP is a fallback
  for a doc whose id the tree hasn't rendered. Closed docs are fetched again
  every 10 s and diffed in, so collaborators' edits to files you don't have
  open arrive as edits too.
- **Editor-agnostic**: `session.ts` knows neither Overleaf nor Chrome. An
  editor is an `EditorHost`, the core sits behind a `CoreTransport`, and the
  preview is a `PreviewSink`. A VS Code port would supply those three.

## Privacy: all local

- The PhiTeX core runs in your browser (WebAssembly, in the extension's
  offscreen document). No server of ours exists, and no code is loaded
  remotely.
- The extension's only network requests go to overleaf.com, as you, for
  your own project's files, the same way the editor gets them.
- Nothing is sent anywhere. The extension never writes to Overleaf and
  never changes your documents.
- No analytics, no storage of your content (it lives in memory while the
  tab is open).
- Permissions: `offscreen` (the core's worker) and `storage` (the panel's
  own layout preferences, never document content), plus content scripts on
  `https://www.overleaf.com/project/*`.

## Limits

- Plain TeX subset only (see PhiTeX's `build.rs`). LaTeX documents are
  shown with a warning and are mostly dropped text.
- Unicode: offsets are exact, but PhiTeX's fonts are the PDF base-14
  metrics, so non-ASCII characters may not typeset.
- A file added to the project after PhiTeX found it missing costs a full
  rebuild (REQUESTS.md 3).
- No SyncTeX yet (editor ↔ page highlighting, click to source): it needs
  source positions from PhiTeX (REQUESTS.md 1).
- Hooking Overleaf relies on its DOM (`.cm-content`'s `cmView`, the file
  tree's `data-file-id`, `aria-label`) and on its endpoints. These are not a
  public API and may change.
- One project per tab. The core's memory is freed when the tab closes.

## Chrome Web Store listing notes

- Free, no monetization, no ads, no accounts: a **non-trader** listing.
- Single purpose: "Show an experimental, locally computed PhiTeX preview of
  the Overleaf project being edited."
- Permission justification: `offscreen` runs the WebAssembly typesetter in a
  worker outside the Overleaf page. `storage` remembers the panel's layout.
  The host match reads the project being edited.
- Data use: no data collected, sold or transferred. Remote code: none (the
  wasm ships in the package; CSP `script-src 'self' 'wasm-unsafe-eval'`).
- Name: not affiliated with Overleaf. The listing and icon must not use
  Overleaf's logo.
