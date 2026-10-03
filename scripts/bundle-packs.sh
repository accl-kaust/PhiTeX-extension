#!/usr/bin/env bash
# The Shelf packs the extension ships (data/bundled-packs.txt: the packs of
# the 100 packages and 15 classes arXiv papers use most, with what they load
# and their fonts; scripts/bundle-packs.py makes the list from the survey in
# data/arxiv-*.tsv) into extension/packs/, with list.txt. From a Shelf
# checkout's public/ (SHELF_DIR) if there, else downloaded (needs --net).
set -euo pipefail
cd "$(dirname "$0")/.."
src="${SHELF_DIR:-$HOME/code/flinner/shelf.PhiTeX.org/public}/tl2026/p"
mkdir -p extension/packs
: > extension/packs/list.txt
while read -r id; do
  [ -z "$id" ] && continue
  if [ -f "$src/$id.pack" ]; then cp "$src/$id.pack" "extension/packs/$id.pack"
  elif [ ! -f "extension/packs/$id.pack" ]; then curl -fsS -o "extension/packs/$id.pack" "https://shelf-phitex.pages.dev/tl2026/p/$id.pack"
  fi
  echo "$id" >> extension/packs/list.txt
done < data/bundled-packs.txt
echo "extension/packs: $(wc -l < extension/packs/list.txt) packs, $(du -sh extension/packs | cut -f1)"
