#!/usr/bin/env bash
# The files the popular packages and classes read (popular.txt), which the
# extension carries in the core's assets so a document using them builds
# with no fetch: each one traced on the preview's engine (trace-deps, PDF
# mode) over a flat copy of TeX Live (Shelf's build makes one: cache/flat).
#   scripts/popular.sh [FLAT_DIR]
set -euo pipefail
cd "$(dirname "$0")/.."
flat="${1:-target/flat}"
pkgs="amsmath amssymb amsthm mathtools graphicx xcolor hyperref geometry tikz pgfplots booktabs array tabularx longtable multirow siunitx caption subcaption float enumitem fancyhdr titlesec microtype babel fontenc inputenc lmodern textcomp csquotes biblatex natbib cleveref url listings algorithm2e algorithmic algorithmicx algpseudocode xspace verbatim fancyvrb tcolorbox mdframed framed wrapfig placeins setspace parskip ragged2e lipsum blindtext etoolbox xparse ifthen calc kvoptions changepage pdfpages pdflscape lscape rotating makecell colortbl xltabular threeparttable dcolumn bm upgreek mathrsfs esint cancel physics tensor braket chemfig mhchem tikz-cd circuitikz forest qtree todonotes comment soul ulem hyphenat footmisc tocloft titletoc appendix glossaries acronym nomencl imakeidx minted pgfgantt standalone svg epstopdf grffile adjustbox subfig authblk orcidlink academicons fontawesome fontawesome5 newtxtext newtxmath mathptmx times helvet courier palatino mathpazo libertine inconsolata sourcesanspro tgtermes amsfonts dsfont stmaryrd xfrac nicefrac units"
classes="article report book beamer memoir scrartcl scrreprt scrbook amsart acmart IEEEtran llncs elsarticle revtex4-2 moderncv exam letter standalone"
names=$(for p in $pkgs; do echo "$p.sty"; done; for c in $classes; do echo "$c.cls"; done)
(ulimit -v 8000000; scripts/sandbox env PHITEX_PDF=1 target/partex/release/trace-deps target/fmt/pdflatex.fmt "$flat" $names) \
  | cut -f2 | tr ',' '\n' | grep -v '^$' | sort -u > popular.txt
echo "popular.txt: $(wc -l < popular.txt) files"
