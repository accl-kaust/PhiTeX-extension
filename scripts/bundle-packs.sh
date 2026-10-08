#!/usr/bin/env bash
# The Shelf packs the extension ships (data/bundled-packs.txt; empty since
# 0.5.2: the packs arXiv papers use most are fetched in the background after
# install, prefetch.ts, data/ahead.txt; scripts/bundle-packs.py still makes a
# list from the survey in data/arxiv-*.tsv) into overleaf/packs/, with
# list.txt, and the list fetched ahead (packs/ahead.txt). From a Shelf
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
rm -rf overleaf/packs
mkdir -p overleaf/packs
: > overleaf/packs/list.txt
named=$(gzip -dc shelf-index.tsv.gz | cut -f2 | sort -u)
while read -r id; do
  [ -z "$id" ] && continue
  h=$(grep -E "^${id//./\.}-[0-9a-f]{12}$" <<<"$named" | head -1 || true)
  # (a pack the release no longer has by that name: fetched from Shelf when used)
  [ -z "$h" ] && { echo "bundled pack $id: not in the shipped index, not bundled" >&2; continue; }
  if [ -f "$src/$h.pack" ]; then cp "$src/$h.pack" "overleaf/packs/$h.pack"
  else curl -fsS -o "overleaf/packs/$h.pack" "https://shelf-phitex.pages.dev/tl2026/h/$h.pack"
  fi
  echo "$h" >> overleaf/packs/list.txt
done < data/bundled-packs.txt
# (and what is fetched ahead: data/ahead.txt, bench/arxiv/coverage.py --ahead)
cp data/ahead.txt overleaf/packs/ahead.txt
# (in scripts/sandbox the checkout is read-only: run once outside it to write the list)
if [ -d "$repo" ]; then cp overleaf/packs/list.txt "$repo/keep-packs.txt" 2>/dev/null || echo "keep-packs.txt: $repo read-only here, not written" >&2; fi
echo "overleaf/packs: $(wc -l < overleaf/packs/list.txt) packs, $(du -sh overleaf/packs | cut -f1)"
