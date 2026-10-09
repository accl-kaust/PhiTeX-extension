#!/usr/bin/env bash
# The viewer every host shows lives in PhiTeX's viewer/src: the panel and
# the session it runs on, the renderer (page2.ts, viewer.ts, sync.ts), beside
# phitex-draw that makes its draw lists: copied
# from the engine commit core-partex pins into common/src/vendor/viewer/,
# never edited here (a change is a PhiTeX commit, then a repin).
#   scripts/vendor-viewer.sh          # copy
#   scripts/vendor-viewer.sh --check  # fail if the copy differs from the pin
set -euo pipefail
cd "$(dirname "$0")/.."
pin=$(grep -oE "partex-phitex-[0-9a-f+]+" core-partex/Cargo.toml | head -1)
# (VIEWER_SRC: another PhiTeX tree's viewer/src, until the pin has it: a branch under review)
src="${VIEWER_SRC:-$HOME/code/tmp/$pin/viewer/src}"
dst=common/src/vendor/viewer
[ -d "$src" ] || { echo "no $src (export the pinned engine commit there)" >&2; exit 1; }
if [ "${1:-}" = "--check" ]; then
  diff -r "$src" "$dst" > /dev/null || { echo "common/src/vendor/viewer differs from $pin's viewer/src: run scripts/vendor-viewer.sh" >&2; exit 1; }
  echo "viewer: as $pin"
  exit 0
fi
rm -rf "$dst"
mkdir -p "$dst"
cp "$src"/*.ts "$dst"/
echo "viewer: copied from ${VIEWER_SRC:-$pin} ($(ls "$dst" | wc -l) files)"
