# Requests to PhiTeX

What the Overleaf preview needs from PhiTeX, or does itself today but
should move into PhiTeX. Ordered by value. Each item says what the extension
does meanwhile. Measured against PhiTeX `241bd29`.

## 1. SyncTeX: source positions on what a page draws

**Need.** What SyncTeX gives pdfTeX: for each thing on a page, where in
the source it came from. Then:
- **Editor → page.** Selecting or moving in the editor highlights the words
  it made, live, on the page they are on (and turns to that page).
- **Page → editor.** Clicking a word selects its source.
- **Build diagnostics at a place** (see 2).

The extension does not guess this with text matching. Repeated phrases,
macro output and `\input` make a guess wrong exactly where it matters, so
the feature waits for PhiTeX.

**What exists.** `ir::Value` has a `line`, but no file (a value read from
`\input chapter` says `l.3`, not which file) and no range. `pack::Draw`,
what a page draws, has neither.

**Shape (a proposal).**
- **Origins on tokens.** Each character token keeps the `(file, byte)` it
  was read from. The builder already re-reads source characters with the
  real catcodes, so it has them. A token that came from a macro's
  expansion keeps the origin of the macro *call*: SyncTeX's rule, "this
  word came from here".
- **A span on each drawn word:** `Draw::Text { .., src: Option<Span> }`,
  with `Span { file: FileId, bytes: Range<u32> }`, the span of the tokens
  that made the word (merged, if they are contiguous in one file). Rules
  and boxes can carry the span of their command.
- **Kept incrementally.** Spans live on the chunk's material. A chunk not
  rebuilt keeps its spans, but byte offsets after an edit move. So store
  them relative to the chunk's first paragraph, which the Doc already
  places (`starts`), and resolve them to absolute bytes only when a page's
  draws are asked for, as values resolve imports only when printed.
- **Queries**, whichever is cheaper to keep:
  - `Doc::page_spans(k) -> Vec<(Span, DrawIndex)>`: the host finds the
    words for a selection itself;
  - `Doc::forward(file, bytes) -> Vec<(page, DrawIndex)>` and
    `Doc::inverse(page, DrawIndex) -> Span`.

**How the extension would use it.** The draw list's words get
`[x, y, size, font, text, file, start, end]`. On an editor selection
(UTF-16, converted to bytes as edits already are), the words whose span
intersects it are highlighted: an SVG `<rect>` behind each `<tspan>`. This
is local and needs no core call, since the page's spans came with its
draws. A selection on another page turns to it (`forward`). A click on a
word selects its span in the editor (the hook's one write: the
selection).

## 2. Diagnostics from the builder, as records (and `--json`)

(With 1's spans, each one points at its place in the source.)

**Need.** The builder knows exactly what the extension guesses with regexes:
- a group still open at the end of a file, and where it opened;
- a `\def` whose body swallowed the rest (0 pages ship);
- `\if…` without `\fi`, and math still open;
- an `\input` of a missing file;
- fuel running out, and in which chunk and macro (a runaway recursion);
- an **undefined control sequence**. Today it is dropped with no trace in
  the program: `\documentclass{article}` becomes the paragraph "article …".
  `build.rs` `command()`: `return; // (undefined: ignored)`. I tried
  emitting `self.constant("undefined \x")` there, the way `reg()` does. The
  constant never reached the program (dead constants are not kept?), so
  that was not the fix, and no patch is included.

**Shape.** `Doc::diagnostics() -> Vec<Diagnostic { severity, code, message,
file, range }>`, kept incrementally like the rest (each chunk's own, merged).
The same list in the CLI as `--json` for tooling, with stable `code`s
(`unclosed-group`, `undefined-cs`, `out-of-fuel`, `missing-file`, …).
`diagnostics.ts` already uses this shape, so it would pass them through.

**Meanwhile.** `diagnostics.ts` scans the source: brace and `$` balance
(skipping comments and escapes), `\def` without a body, `\if`/`\fi` counts,
`\input` of files not in the project, LaTeX markers, non-ASCII. These are
heuristics; they do not expand macros.

## 3. A file that appears after it was found missing

**Need.** Once `\input part` resolves `part` to missing (`FileKind::Missing`),
the chunk that read it records no dependency on that file. A later
`edit_file("part.tex", 0..0, "")` returns early (`splice`: Missing → return),
and nothing is rebuilt. This is Overleaf's "new file", and the case where
files are fetched on demand.

**Shape.** Record each file a chunk *looked up*, found or not, among its
imports, or in `readers` keyed by file name. Then add
`Doc::add_file(name, text) -> EditStats`, which turns Missing into Source
and queues those readers.

**Meanwhile.** A new file costs a full `Doc::project_with_fuel` rebuild
(`core/src/lib.rs`, `Session::set_file`). It is also why the extension
fetches all docs up front instead of on demand.

## 4. `edit_view` in two halves

**Need.** `edit_view` paints the page first and then runs to the fixed
point, but it returns only after both. Across the worker boundary the host
therefore cannot show the first paint before the fixed point. It gets both
at once, and `paint_ms` is a number, not something the user sees earlier.

**Shape.** `Doc::edit_view_begin(..) -> Option<Rc<BoxVal>>` (spliced, run up
to the page's output chunk), then `Doc::finish() -> View` (the rest). Or an
agenda the host can step: `Doc::step(budget)`. The host would post the
first paint, then call `finish`, and could drop `finish` if another
keystroke arrives: `edit_view_begin` again from where it is.

## 5. Several edits, one run

**Need.** A flush can hold edits at several places (multi-cursor, a
collaborator's transaction, two files). Each `edit_file` runs to the fixed
point, so N edits cost N runs.

**Shape.** `Doc::edit_files(&[(name, range, text)]) -> EditStats`: splice all
of them, then one `run` + `converge`.

**Meanwhile.** Adjacent edits are merged (`edits.ts`), and only the last
edit of a round is painted. Separate places still cost a run each.

## 6. A cheap status

**Need.** Pages pending (out of fuel or unsupported) are only visible by
flattening the program: `Doc::program()` is O(document), 4.2 ms at 180 KB,
against 0.26 ms for the edit itself.

**Shape.** `Doc::pending() -> usize` (and the undefined names, see 2), kept
per chunk.

**Meanwhile.** The status scan runs off the keystroke path, once edits
settle, at most every 300 ms (`ph_status`).

## 7. UTF-8 input, and fonts beyond the base 14

**Need.** Non-ASCII input is read byte by byte: `Ünï` typesets as `Ã…`. The
PDF writer turns non-ASCII into `?`, and the metrics are base-14 Times,
Helvetica and Courier only.

**Meanwhile.** Offsets are exact (UTF-16 → UTF-8, tested), so edits never
split a character. The panel warns ("N non-ASCII characters").

## 8. The page as a draw list, public and with widths

**Need.** The vector preview uses `phitex_layout::pdf::draws` (public, good)
and paints words with the browser's Times. Word positions are PhiTeX's, but
a browser glyph run can be wider or narrower than TeX's. A word's TeX width
on `Draw::Text` would let the host stretch it to fit
(`ctx.fillText(text, x, y, maxWidth)`). Also: page size per page (today the
`PAGE_WIDTH`/`PAGE_HEIGHT` consts, US Letter), and the margin convention.

**PNG.** `png::page` writes *stored* (uncompressed) deflate: 0.9 MB a page
at 96 dpi, and glyphs are grey boxes. Either deflate it, or export raw
8-bit pixels and let the host encode. The extension recompresses in the
worker (~40 ms), but defaults to vector.

## 9. Threads

The core is going multithreaded. `Doc` holds `Rc`, `RefCell` and
`thread_local!` (`build::PLAIN`, `VOID`), so it is `!Send`: one `Doc` lives
on one thread. For wasm threads (`wasm32-wasip1-threads`, SharedArrayBuffer)
this needs one of:
- work *inside* a `Doc` parallelized with `Send` data (`Arc`, owned
  chunks), with the `Doc` itself staying on its thread; or
- a `Doc` that is `Send`, to move whole.

The extension is ready for either. Each `Doc` sits behind a session handle
(never a bare global), and the core runs in an extension page (the
offscreen document) that can be made cross-origin isolated. Note:
COEP `require-corp` on the extension blocked the worker script today
(REPORT.md), so isolation needs a worker-loading scheme that satisfies it
(COEP on the worker's own response, which extension resources can't set).

## 10. `std::time::Instant` on wasm32-unknown-unknown

`Doc::edit_view`, `prof::Scope` and `Typeset::project_timed` call
`Instant::now()`, which panics on wasm32-unknown-unknown. The extension
avoids it by building for **wasm32-wasip1** (a WASI reactor, with its own
tiny shim). To build with wasm-bindgen instead, apply
`patches/0001-phitex-web-time-instant.patch`: an optional `web-time`
feature on phitex-ssa and phitex-layout. It is tested: phitex-layout builds
for wasm32-unknown-unknown with `--features web-time`, and PhiTeX's tests
pass (45 + 4).

## 11. Fonts that match Overleaf's page: Computer Modern, with glyphs

**Need.** Docked next to (or in place of) Overleaf's PDF, the preview is
compared glyph for glyph. Overleaf's page is Computer Modern (TeX's own
fonts). PhiTeX has only base-14 metrics (Times-Roman, …). The draw list
names those fonts, and the extension paints them with the browser's Times.
So line breaks and positions are PhiTeX's but the look is not TeX's, and a
plain-TeX document (whose default is `cmr10`) cannot look like its pdfTeX
output.

**Shape.** Computer Modern metrics (the `.tfm` files, or their widths, as
`metrics.rs` has for base 14) for the plain-TeX defaults (`cmr10`,
`cmbx10`, `cmti10`, `cmmi10`, `cmsy10`, `cmtt10` at their sizes). Also a
way to get each font's glyphs to the host: the draw list naming
`Font { name: "cmr10", file: … }`, so the host can load the matching
webfont (Latin Modern / CMU, OFL-licensed, bundled with the extension,
never fetched), or the PDF embedding a Type 1 font. With 8's widths, the
host could also correct any remaining gap per word.

**Meanwhile.** Browser Times, with PhiTeX's positions.

## 12. Page geometry per page

The draw list takes page size from `pdf::PAGE_WIDTH`/`PAGE_HEIGHT` (US
Letter, fixed) and a fixed 1 in `MARGIN`. Overleaf projects are often A4,
and TeX sets the page with `\hsize`/`\vsize`/`\hoffset`/`\voffset`
(and `\pdfpagewidth` for pdfTeX). A page's own size and offsets, on
what `ships()` gives, would make the preview's page the size of the real
one.

## 13. A LaTeX kernel

Real Overleaf projects are LaTeX. Until the kernel is there, the preview
drops `\documentclass`, `\usepackage`, `\begin{…}` and `\section` and shows
the words left over (see REPORT.md).
