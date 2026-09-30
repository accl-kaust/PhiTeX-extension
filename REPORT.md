# Report: a live PhiTeX preview in Overleaf

Built against PhiTeX `241bd29`, exported read-only with `git archive` to
`~/code/tmp/phitex-241bd29`. PhiTeX's working tree did not compile at the
time (a refactor in progress), so the export pins HEAD. Nothing was written
into the PhiTeX repo.

## What was built

- **`core/`**: a Rust cdylib over `phitex_ssa::Doc`, for **wasm32-wasip1**,
  with a raw C ABI (`ph_open`, `ph_edit`, `ph_status`, `ph_png`, `ph_pdf`,
  `ph_check`, `ph_set_file`, `ph_text`). Each `Doc` sits behind a session
  handle, so a threaded build can keep one per thread.
- **`extension/`**: MV3.
  - `hook.ts` runs in the page's world. It finds CodeMirror 6's `EditorView`
    (`.cm-content` → `cmView.view`) and wraps `update` and `setState` to
    read each transaction's changes and file switches.
  - `session.ts` is the editor-agnostic session: batching, backpressure,
    page-first painting, diagnostics, the debug check.
  - `content-main.ts` holds the Overleaf wiring. `panel.ts` is the UI.
  - The core runs in an **offscreen document**'s Worker (`worker.ts`, with a
    40-line WASI shim).
- **Tests** (`scripts/sandbox node --test test/`, 18 in all):
  - UTF-16 → UTF-8 conversion over non-ASCII, emoji and surrogate pairs;
    merging; `Batch`, with 500 random batch runs checked against real UTF-8
    byte application.
  - Session order across files, and backpressure: 40 keystrokes against a
    50 ms build take ≤ 6 builds.
  - Diagnostics.
  - The built `core.wasm` under node:wasi: edits in bytes, refused bad
    ranges, invariant check, PNG, PDF.
  - Plus 3 Rust tests in `core/`.
- **`mock/`**: a mock Overleaf, with its editor DOM, the CM6 `EditorView`
  surface the hook uses, file tree and endpoints. Used for the end-to-end
  runs below.

## PhiTeX API used

| call | where |
|---|---|
| `Doc::project_with_fuel(files, main, fuel)` | open; the fresh build of the debug check |
| `Doc::edit_file(name, bytes, text)` | every edit but the last of a round; whole-file sets |
| `Doc::edit_view(name, bytes, text, page)` → `View { painted, paint, total, wrong, stats }` | the last edit of a round, seen from the page shown |
| `Doc::ships()`, `Doc::page_box(k)` | page count; a page to draw |
| `Doc::program()` + `ir::Def::{Pending, Const}` | the status (pending values), off the keystroke path |
| `phitex_layout::pdf::{draws, content, write}` | the vector preview (draw list → SVG); the PDF, with each page's stream cached by its box's hash (as `Typeset::pdf`) |
| `phitex_layout::png::page` | the PNG view |
| `Files` (trait), implemented by a shared in-memory `Mirror` | the Doc reads each file when `\input` first asks |

The names from the brief were right. `phitex_layout::Typeset` is **not**
used: it has no fuel parameter and no access to its `Doc`, and its PDF
cache is easy to redo. (A `Typeset::project_with_fuel` or `Typeset::doc_mut`
would make it usable.)

## Decisions worth knowing

1. **wasm32-wasip1, not wasm-bindgen.** `Doc::edit_view` and `prof` call
   `std::time::Instant::now()`, which panics on wasm32-unknown-unknown. On
   wasip1 it is `clock_time_get`, answered by the worker's shim from
   `performance.now()`. The build imports only 5 WASI functions. Two traps
   found on the way:
   - **A cdylib gets no `_initialize`.** Without it, wasi-libc's
     constructors never run, and std's first thread-local destructor
     registration spins forever in `__pthread_key_delete`, so `ph_open`
     hung. `-Zwasi-exec-model=reactor` applies to binaries only. The fix is
     linking the toolchain's `crt1-reactor.o` and exporting `_initialize`
     (`scripts/build.sh`).
   - The alternative, for wasm-bindgen, is the `web-time` patch
     (`patches/0001`, tested).
2. **Offscreen document, not a Worker from the page.** A Worker started
   from Overleaf's page could never be cross-origin isolated, and the
   planned threads need SharedArrayBuffer. The offscreen document is an
   extension page, which can be isolated. But **COEP `require-corp` in the
   manifest blocked the extension's own worker script** (its response has
   no COEP header), so COEP/COOP are off for now. See REQUESTS.md 9.
3. **Vector, not PNG.** PhiTeX's PNG is stored-deflate (0.9 MB a page at
   96 dpi) with grey boxes for glyphs. Across the chrome port as base64 it
   cost ~270 ms per keystroke. The draw list is a few KB. It is painted as
   **SVG** text: real glyphs, selectable and copyable, crisp at any zoom,
   Ctrl+F finds it. PNG is still available: the worker recompresses it
   losslessly (~20× smaller, ~40 ms).
4. **Backpressure, not per-frame builds.** At most one build is in flight.
   Keystrokes typed meanwhile merge into one edit. A fast core builds every
   keystroke; a slow one builds the last N together, and never builds a
   state that is already stale.
5. **Files without the ZIP.** `GET /project/:id/entities` lists paths. The
   file tree's `data-file-id` gives each doc's id, and
   `GET /project/:id/doc/:id/download` gives its text. Only text docs are
   fetched. The ZIP is a fallback for a doc whose id isn't rendered yet.
   - **Tradeoffs.** The endpoints are Overleaf's own (used by the web app),
     not a public API. The ZIP is one request, but it carries every image
     and only the server's saved state.
   - **Editor state wins.** The editor's text of the open file is
     authoritative (unsaved edits).
   - **Closed files are polled.** They are re-fetched every 10 s and diffed
     in as edits, because Overleaf's socket only streams the open doc's
     ops. The open doc is live through CodeMirror, collaborators included.
6. **Status off the hot path.** Flattening `Doc::program()` to count
   pending values costs 4.2 ms at 180 KB, 16× an edit. It runs once edits
   settle, at most every 300 ms.

## Measured latencies

**Browser, end to end** (Chromium 153, mock Overleaf, vector view).
Keystroke→page is from the keystroke's transaction to the page on screen.

| | keystroke→page | of which: in the core | round trip (port → offscreen → worker) |
|---|---|---|---|
| typing, 3-paragraph doc | 4.5–20 ms | 0.2–1.9 ms | 2.4–6 ms |
| real Overleaf, 46 keys via CDP key input | 8.7 ms | 0.3–0.8 ms | ~5 ms |
| before: PNG over the port | 290 ms | 0.6 ms | 276 ms |
| before: PNG recompressed | 78 ms | 0.6 ms | 67 ms (40 ms of it PNG encoding) |

Typing faster than the core builds coalesces: 24 keystrokes 5 ms apart
went out as 2 builds.

**Core** (`scripts/sandbox node bench/latency.mjs`, the same wasm in V8,
medians of 11). Edits insert a character at the start, middle or end,
painted from the page it's on.

| document | pages | open | first paint | fixed point | + draw list | status scan | debug check |
|---|---|---|---|---|---|---|---|
| 3 paragraphs | 1 | 16 ms | 0.06–0.09 ms | same | 0.2 ms | 0.03 ms | 0.8 ms |
| 200 paragraphs, 18 KB | 4 | 10 ms | 0.10–0.26 ms | same | 0.9–1.9 ms | 0.6 ms | 5.2 ms |
| 2000 paragraphs, 185 KB | 38 | 62 ms | 0.23–0.26 ms | 0.26–0.28 ms | 0.3–1.4 ms | 4.2 ms | 47 ms |
| `book.tex` + main (refs, the .aux loop) | 6 | 15 ms | 0.14–0.21 ms | same | 0.9–1.4 ms | 1.0 ms | 8.8 ms |

- **First paint equals the fixed point** in these runs because the edits
  did not move page breaks (1 pass). The split matters when an edit
  reflows later pages, and only once PhiTeX can return the first paint
  early (REQUESTS 4).
- **Incomplete input.**
  - **Nothing traps**: an open `{`, a stray `}`, an unclosed `\def\x{`,
    `\if` without `\fi`, open `$`, a missing `\input`, no `\bye`, a lone
    `\`.
  - **An open group costs a little**: edits there take ~5 ms, since the
    group runs to the end.
  - **An unclosed `\def` ships 0 pages.** The panel keeps the last page,
    dimmed, and says why.
  - **`\def\a{\a}\a` runs out of fuel**: 218 ms per keystroke at fuel 10⁶,
    so the default is now 10⁵ per chunk.

**The invariant** (debug check: incremental = a fresh build, and the core's
text = the editor's) held in every run:
- the mock: typing, a two-change collaborator transaction, file switches,
  multi-change edits with emoji;
- real Overleaf: typing, then a whole-document replace to restore the
  original.

## What breaks on real Overleaf LaTeX projects

Tested on the project `6abc4b17…`, a new-project `article` template:
- **LaTeX is not typeset.** `\documentclass`, `\usepackage`, `\title`,
  `\begin{document}`, `\maketitle` and `\section` are undefined in PhiTeX,
  which drops them without a trace. The page shows the leftover words:
  "article graphicx PhiTeX Test Ammar Seliaman September 2026 document
  Introduction". The panel reports 1 page and flags "LaTeX is not supported
  yet" at `main.tex:1` from a source scan, because PhiTeX's program itself
  shows nothing wrong (0 pending, 0 undefined). REQUESTS 2.
- **Unicode input** is read byte by byte (`Ünï` → `Ã…`). Fonts are base-14
  metrics only.
- **Everything else in a typical project is unsupported:**
  - `\includegraphics` and images (never fetched);
  - `.bib` via biber or biblatex (PhiTeX's BibTeX loop is its own);
  - `\usepackage` of anything;
  - `.cls` and `.sty` from TeX Live (not in the project);
  - tikz, math beyond the subset.
- **Which main file?** Overleaf's root doc isn't in the page's meta tags.
  The main is guessed (`\bye`/`\documentclass`, `main.tex`), and you can
  change it.
- **Fragile hooks.** The integration reads Overleaf's DOM (`cmView`, the
  file tree's `data-file-id`/`aria-label`) and undocumented endpoints. A
  frontend change can break it; the panel then shows an error, and never
  breaks the editor. Overleaf's `UNSTABLE_editor:extensions` event is a
  possible more official hook.
- **Closed files lag by up to 10 s** when edited by collaborators (polling).

## PhiTeX changes needed

All are in **REQUESTS.md**, ordered by value:
1. SyncTeX source spans on draws;
2. builder diagnostics with a `--json` shape, including undefined commands
   dropped without a trace;
3. a missing file becoming present;
4. `edit_view` in two halves;
5. batched edits;
6. a cheap pending count;
7. UTF-8 input;
8. draw-list widths, and PNG deflate;
9. `Send`/threads;
10. `web-time` (a tested patch: `patches/0001-phitex-web-time-instant.patch`,
    apply with `git apply` in PhiTeX);
11. the LaTeX kernel.

None of them blocks the extension today.

## UI

- **Docked** in Overleaf's PDF pane behind an **Overleaf compiler | PhiTeX**
  switch.
- **Overleaf's own markup** for the controls. It is copied from its source
  (`overleaf/overleaf` `services/web/frontend`): pdf-hybrid toolbar,
  toggle-switch, popover. Its theming follows `data-theme`, `--pdf-bg`, and
  `.pdf-dark-mode`'s invert filter.
- **Floating window as fallback**, only when that DOM isn't found 8 s after
  load.
- **First run:** a tip in Overleaf's popover style points at the switch.

## Not done / next

- SyncTeX-style highlighting and click-to-source: waiting on REQUESTS 1.
  Text matching was tried and dropped as too inexact.
- A `--json` diagnostics mode. The records are already in that shape
  (`diagnostics.ts`).
- VS Code: implement `EditorHost`, `CoreTransport` and `PreviewSink`
  (`session.ts`) with the VS Code API and a webview. The wasm and the
  session carry over.
- Threads: `wasm32-wasip1-threads` plus a COEP-compatible worker load.
