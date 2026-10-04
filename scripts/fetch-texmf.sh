#!/usr/bin/env bash
# Download the LaTeX packages the extension bundles, from TeX Live's
# package archive (ready .sty/.cls files, no .dtx unpacking), into texmf/, flat
# by name (the offscreen document looks them up there before Shelf).
# Run: scripts/sandbox --net scripts/fetch-texmf.sh
set -euo pipefail
cd "$(dirname "$0")/.."
MIRROR=${TL_MIRROR:-https://mirror.ctan.org/systems/texlive/tlnet/archive}
PKGS=(
  latex latex-fonts l3kernel l3packages
  graphics graphics-cfg graphics-def tools
  amsmath amsfonts amscls xcolor geometry url booktabs
  enumitem caption hyperref kvoptions kvsetkeys ltxcmds
  etoolbox xkeyval fancyhdr titlesec float multirow
)
out=texmf; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
rm -rf "$out"; mkdir -p "$out"
: > "$out/MANIFEST.tsv"
for p in "${PKGS[@]}"; do
  echo "fetch $p" >&2
  curl -fsSL "$MIRROR/$p.tar.xz" -o "$tmp/$p.tar.xz" || { echo "  missing: $p" >&2; continue; }
  mkdir -p "$tmp/$p"; tar -xJf "$tmp/$p.tar.xz" -C "$tmp/$p"
  rev=$(sed -n 's/^revision //p' "$tmp/$p/tlpkg/tlpobj/$p.tlpobj" 2>/dev/null | head -1)
  printf '%s\t%s\t%s\n' "$p" "${rev:-?}" "$(sha256sum "$tmp/$p.tar.xz" | cut -d' ' -f1)" >> "$out/MANIFEST.tsv"
  [ -d "$tmp/$p/tex" ] || continue
  find "$tmp/$p/tex" -type f \( -name '*.sty' -o -name '*.cls' -o -name '*.clo' \
       -o -name '*.def' -o -name '*.cfg' -o -name '*.fd' -o -name '*.ltx' -o -name '*.tex' \) |
  while read -r f; do
    # (flat by name, as Shelf serves them: the first package listed wins)
    n=$(basename "$f"); [ -e "$out/$n" ] || cp "$f" "$out/$n"
  done
done
# BibTeX's styles, every .bst of TeX Live 2026, for the BibTeX the build runs
# between its trips (Shelf has no bibtex/ tree): from the local TeX Live, which
# must be 2026 (TEXMFDIST overrides where it is)
dist=${TEXMFDIST:-$(kpsewhich -var-value TEXMFDIST)}
find "$dist/bibtex/bst" -type f -name '*.bst' | sort | while read -r f; do
  n=$(basename "$f"); [ -e "$out/$n" ] || cp "$f" "$out/$n"
done
printf '%s\t%s\t%s\n' "bibtex/bst" "local $(pdftex --version | head -1 | grep -o 'TeX Live [0-9]*')" "-" >> "$out/MANIFEST.tsv"
find "$out" -type f ! -name MANIFEST.tsv ! -name names.txt -printf '%f\n' | sort > "$out/names.txt"
echo "files: $(find "$out" -type f ! -name MANIFEST.tsv | wc -l)" >&2
