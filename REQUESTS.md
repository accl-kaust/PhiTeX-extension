# Requests to partex-PhiTeX

What the Overleaf preview needs from partex-PhiTeX, ordered by value. Each
item says what the extension does meanwhile. Measured against main
`cd9e6b6`, embedded as `core-partex/` (a wasm32-wasip1 reactor; an
in-memory `Host`; the panel's draw list made from `pageir::Page`).

## 1. The incremental build, usable without the CLI

**Need.** `ssa::run_applying` and `ssa::rebuild_trips` are in
`partex-core` and build for wasm. Turning a rebuild into files is not:
`SsaLinker` (the spliced link, `link_full`, `write_full`, `names`) lives in
`partex-cli/src/main.rs`, typed on `NativeHost`, and uses
`std::time::Instant`, `HashMap` and the system zlib.

**Shape.** A `partex_core::ssa::Linker` (or `effects::Linker`), generic over
`H: Host`, with the link's state (`Splice`, the deflate cache, what was last
written by name), `link(&mut Tex<H, SsaTracker>) -> LinkReport`, and the
clock and deflate passed in (as `Trips::clock` already is). The CLI would
keep only its reporting.

**Meanwhile.** Every edit is a cold build (`Untracked`): about 80 ms native,
150 to 280 ms in wasm for a one-page article. A long document is unusable.

## 2. Edits as edits, and a page to see first

**Need.** The host knows what changed: a byte range in one file, many times
a second. Today a rebuild finds changes by reloading every loaded file and
comparing (`Host::unchanged` can only answer "same"). DESIGN 4.3 item 3
sets the target (16.7 ms for a word, rebuild and link).

**Shape.**
- `ssa::edit(tex, file, bytes: Range<usize>, text)`, or `Host::unchanged`
  with the changed line ranges, so a rebuild costs what the edit reaches.
- The page in view first: `rebuild` that stops once page `k` shipped (or
  reports when it did, through `Host::page_written` in DVI mode), then the
  rest. The panel paints the page under the cursor before the fixed point.
- Pages changed by a rebuild: the shipped pages with a version or hash, so
  the host redraws only those (it hashes `Page` itself today).

## 3. Pages to the host in PDF mode too

**Need.** The preview draws pages from `pageir::Page`, which reaches the
host only in DVI mode (`Host::page_written` from `dvi.rs`). So the build
runs with `\pdfoutput=0`, which is not Overleaf's build: `graphicx`,
`hyperref` and `l3backend` take their dvips paths, and the page size is
lost (only a `papersize` special gives it).

**Shape.** `Host::page_shipped(&Page, PageGeometry)` at `ship_out` in both
modes, where `PageGeometry` holds `\pdfpagewidth` and `\pdfpageheight` (or
`\paperwidth`), and the offsets. Then the preview builds in PDF mode, and
the PDF download is the same job (item 4).

## 4. A PDF in wasm: deflate without the system zlib

**Need.** pdfTeX's PDF needs `Host::deflate`, and partex gets byte-exact
streams from the system zlib by FFI (`partex-cli/src/zlib.rs`), which does
not exist in wasm32-wasip1. Without it, streams are stored, and the PDF is
valid but large.

**Shape.** A pure-Rust deflate that matches zlib's output (partex's own
deflate, if it is byte-exact at pdfTeX's levels), behind a `partex-core`
function that any host can call.

**Meanwhile.** `ph_pdf` returns nothing, and the PDF button is dead with the
partex core.

## 5. A file found later, without stopping the job

**Need.** A missing `\input`, `.sty` or `.tfm` is fatal with no terminal
(`term_read_line` → `None`). The host learns names one at a time, and each
name costs a build: 14 builds for article + amsmath + graphicx, about 20 for
a one-page test.

**Shape.** Either of:
- `Host::read_file` able to say "not yet" (`Pending`), so the job
  records every name it needs in one run and the host fetches them in
  parallel; or
- a dependency pre-pass: the `\documentclass`, `\usepackage` and
  `\RequirePackage` graph from `phitex-doc` (DESIGN 4.3 item 6), so the host
  fetches the closure first.

With item 1, a file that arrives should wake only its loads (a rebuild), not
a cold build.

## 6. A format built in, or a documented `.fmt` contract

**Need.** The extension ships `pdflatex.fmt` (15.6 MB, 0.79 MB gzipped),
made by `core-partex`'s `mkfmt` with the same engine and TeX Live's
`texmf.cnf` sizes (`texlive_params`). A format made by a different partex
commit, or with other sizes, is undefined behaviour from the extension's
side.

**Shape.** A format header that partex checks (engine commit or format
version, and the sizes), with a clear error on a mismatch. Also: the sizes
`texmf.cnf` sets, as one `Params::texlive()` instead of each embedder
copying them.

## 7. Glyphs: fonts for the screen

**Need.** The draw list names TeX fonts (`cmr10`, `cmmi10`, `tcrm1000`, …).
The panel paints them with the browser's Times, and maps math characters
by hand (`draws.rs`, `glyph`).

**Shape.** A character's Unicode meaning by font encoding (OT1, OML, OMS,
OMX, T1, TS1: pdfTeX's `glyphtounicode` and the `.enc` files say it), in
`partex-core` or `pageir`. Better still, each page's Type 1 glyphs as paths
(what `writet1` already parses), so the host can draw TeX's own glyphs.

## 8. SyncTeX

**Need.** Selecting in the editor should highlight on the page, and
clicking the page should jump to the source. pdfTeX has `\synctex`.

**Shape.** Each `Item::Char` and `Item::Rule` (or each box) in the page IR
with its input position (file, line, and better a byte offset), as SyncTeX
records them. Or the `.synctex` records through the host.

## 9. A wasm build in partex's gate

`partex-core` is `no_std` and `cargo check`s for wasm32-unknown-unknown,
but nothing runs it as wasm. `core-partex` does: an INITEX page, a LaTeX
article from `pdflatex.fmt` under `node:wasi` (`test/partex-harness.mjs`,
`test/partex-latex.mjs`). A gate step that builds partex-core for
wasm32-wasip1 and runs one job would catch a `std`-only API or an
`Instant` before an embedder does.

## 10. A stable embedding API

partex is mid-rewrite (DESIGN 4.3: windows, records, the link), and
`core-partex` uses `Tex::new`, `Tex::run`, `host_mut`, `Params`, `pageir`
and, next, `ssa::run_applying`, `rebuild_trips`, `step_effects` and
`take_step_changes`. Wanted: a small `partex_core::embed` (open a job, edit,
rebuild, take pages and files) that stays stable while the internals
change. The extension would pin to it instead of to a commit.
