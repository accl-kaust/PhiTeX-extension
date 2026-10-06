#!/usr/bin/env bash
# The Shelf packs the extension ships (data/bundled-packs.txt: the packs of
# the 100 packages and 15 classes arXiv papers use most, with what they load
# and their fonts; scripts/bundle-packs.py makes the list from the survey in
# data/arxiv-*.tsv) into extension/packs/, with list.txt. From a Shelf
# checkout's releases (SHELF_RELEASES; default SHELF_REPO/releases, e.g.
# SHELF_RELEASES=$SHELF_REPO/releases-s3 for a local schema-3 release; the
# sandbox binds SHELF_REPO read-only), else downloaded from the live Shelf
# (needs --net). Writes Shelf's keep-packs.txt too (SHELF_REPO/keep-packs.txt):
# release.py's GC keeps the packs a shipped extension bundles.
set -euo pipefail
cd "$(dirname "$0")/.."
repo="${SHELF_REPO:-$HOME/code/flinner/shelf.PhiTeX.org}"
# (by the names the shipped index gives them: content-named, under h/)
src="${SHELF_RELEASES:-$repo/releases}/tl2026/h"
rm -rf extension/packs
mkdir -p extension/packs
: > extension/packs/list.txt
named=$(gzip -dc shelf-index.tsv.gz | cut -f2 | sort -u)
while read -r id; do
  [ -z "$id" ] && continue
  h=$(grep -E "^${id//./\.}-[0-9a-f]{12}$" <<<"$named" | head -1 || true)
  # (a pack the release no longer has by that name: fetched from Shelf when used)
  [ -z "$h" ] && { echo "bundled pack $id: not in the shipped index, not bundled" >&2; continue; }
  if [ -f "$src/$h.pack" ]; then cp "$src/$h.pack" "extension/packs/$h.pack"
  else curl -fsS -o "extension/packs/$h.pack" "https://shelf-phitex.pages.dev/tl2026/h/$h.pack"
  fi
  echo "$h" >> extension/packs/list.txt
done < data/bundled-packs.txt
# (in scripts/sandbox the checkout is read-only: run once outside it to write the list)
if [ -d "$repo" ]; then cp extension/packs/list.txt "$repo/keep-packs.txt" 2>/dev/null || echo "keep-packs.txt: $repo read-only here, not written" >&2; fi
echo "extension/packs: $(wc -l < extension/packs/list.txt) packs, $(du -sh extension/packs | cut -f1)"
