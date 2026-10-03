#!/usr/bin/env bash
# Take Shelf's index (name -> pack) into the extension: run after Shelf's
# build (../shelf.PhiTeX.org/build.py), with the same TeX Live label, and
# deploy Shelf before shipping an extension with the new index.
#   scripts/shelf-index.sh [path/to/shelf.PhiTeX.org] [label]
set -euo pipefail
cd "$(dirname "$0")/.."
shelf="${1:-../shelf.PhiTeX.org}"; label="${2:-tl2026}"
gzip -9nc "$shelf/public/$label/index.tsv" > shelf-index.tsv.gz
echo "shelf-index.tsv.gz: $(gzip -dc shelf-index.tsv.gz | wc -l) names, $(stat -c %s shelf-index.tsv.gz) bytes"
