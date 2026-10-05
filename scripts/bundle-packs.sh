#!/usr/bin/env bash
# The Shelf packs the extension ships (data/bundled-packs.txt: the packs of
# the 100 packages and 15 classes arXiv papers use most, with what they load
# and their fonts; scripts/bundle-packs.py makes the list from the survey in
# data/arxiv-*.tsv) into extension/packs/, with list.txt. From a Shelf
# checkout's public/ (SHELF_DIR) if there, else downloaded (needs --net).
set -euo pipefail
cd "$(dirname "$0")/.."
# (by the names the shipped index gives them: content-named, under h/)
src="${SHELF_DIR:-$HOME/code/flinner/shelf.PhiTeX.org/releases}/tl2026/h"
rm -rf extension/packs
mkdir -p extension/packs
: > extension/packs/list.txt
named=$(gzip -dc shelf-index.tsv.gz | cut -f2 | sort -u)
while read -r id; do
  [ -z "$id" ] && continue
  h=$(grep -E "^${id//./\.}-[0-9a-f]{12}$" <<<"$named" | head -1 || true)
  [ -z "$h" ] && { echo "bundled pack $id: not in the shipped index" >&2; exit 1; }
  if [ -f "$src/$h.pack" ]; then cp "$src/$h.pack" "extension/packs/$h.pack"
  else curl -fsS -o "extension/packs/$h.pack" "https://shelf-phitex.pages.dev/tl2026/h/$h.pack"
  fi
  echo "$h" >> extension/packs/list.txt
done < data/bundled-packs.txt
echo "extension/packs: $(wc -l < extension/packs/list.txt) packs, $(du -sh extension/packs | cut -f1)"
