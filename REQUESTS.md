# Requests to partex-PhiTeX

What the Overleaf extension needs from the engine, open items first, in
priority order. Rule: an engine gap is fixed in the engine, never worked
around in the extension. Updated 2026-10-06 against engine `3459953`
(extension branch `xetex`, 0.3.0).

## Open

### XeTeX (0.3.0, the launch video)

1. **`\XeTeXlinebreaklocale`** (and `\XeTeXlinebreakskip`,
   `\XeTeXlinebreakpenalty`): fatal today ("not implemented in partex
   yet"). Every polyglossia `chinese`/`japanese` document hits it, and so do
   `xeCJK` and `ctex` setups. Needed: ICU-style (UAX #14) break opportunities
   in native-font text, matching xelatex on CJK first.
2. **Type 1 / TFM glyphs in the glyph runs** (`GlyphSource::Type1`, agreed):
   classic CM math under xelatex without `unicode-math` (`$\sum$`) has no
   runs. xdvipdfmx embeds those fonts as CFF, and the viewer draws ∑ as "P".
5. **Text of RTL and complex scripts in the runs**: the selectable text over
   Arabic, Hebrew and Devanagari is scrambled. Needed: each run's or
   cluster's Unicode text in logical order (what ToUnicode / ActualText
   give).
6. **Colour stack and CTM on the runs** (agreed): `\textcolor` draws black;
   `\rotatebox` and TikZ-transformed text are misplaced.

### Embedding

8. **The incremental link in `partex-core`**: `SsaLinker` (spliced link,
   `link_full`, `Resolver`) lives in `partex-cli`, typed on `NativeHost`.
   The extension carries its own port (`core-partex` `link_spliced`,
   `link_full`), which has to follow every engine change. Wanted: a
   `Linker` generic over `H: Host`, with the clock and deflate passed in.
9. **The page in view first**: a rebuild that reports (or stops) once page
   `k` has shipped, so a long document paints the page under the cursor
   before the fixed point.
10. **A format contract**: a format header the engine checks (engine commit
    or format version, and the sizes), with a clear error on a mismatch; and
    `Params::texlive()` instead of each embedder copying `texmf.cnf`'s sizes
    (`core-partex` `texlive_params`).
11. **Byte-exact deflate in `partex-core`**: wasm has no system zlib, so the
    extension deflates with `miniz_oxide`. Its PDF is valid but not
    byte-identical to pdflatex's.
12. **A wasm job in the gate**: `xtask check` builds the core for
    `wasm32-unknown-unknown` but never runs it. One job under
    `wasm32-wasip1` (an INITEX page, or a LaTeX article from a format) would
    catch a `std`-only API before an embedder does.
13. **A stable embedding API** (`partex_core::embed`: open a job, edit,
    rebuild, take pages and files) that the extension pins to instead of a
    commit.

## Done

- Pages in PDF mode: the build is Overleaf's (PDF mode), and the viewer reads
  the PDF back.
- Files found mid-build: the Host fetches from Shelf inside `read_file`; no
  rebuild per missing name.
- Edits: `Host::unchanged` per load, with keystrokes rebuilding only what
  they reach.
- pdfTeX glyphs from the PDF's Type 1 outlines, and SyncTeX for pdfTeX
  (`set_origins`, `tex.origins`).
- A trip that ends fatally keeps the last complete streams (`keep_complete`,
  `withheld_streams`, `fatal_pdf`, `cbc95ab`).
- XeTeX: `Flavor::XeTeX`, fonts through the Host (`FontIndex`, `OpenType`),
  harfrust shaping, xdvipdfmx in process, glyph runs (`3459953`).
- `\write18` (restricted) through `Host::system`, for minted.
- XeTeX glyph origins (SyncTeX on xelatex), xdvipdfmx errors as `Result`,
  `\XeTeXglyphbounds` (xeCJK, ctex) (`182fb8a`). HaranoAji was no bug: write
  `{HaranoAjiMincho}`, as real xelatex needs too.
