#!/usr/bin/env bash
# The page renderer (page2.ts, viewer.ts, sync.ts, types.ts, css.ts) lives in
# PhiTeX's viewer/src, beside phitex-draw that makes its draw lists: copied
# from the engine commit core-partex pins into extension/src/vendor/viewer/,
# never edited here (a change is a PhiTeX commit, then a repin).
#   scripts/vendor-viewer.sh          # copy
#   scripts/vendor-viewer.sh --check  # fail if the copy differs from the pin
set -euo pipefail
cd "$(dirname "$0")/.."
pin=$(grep -oE "partex-phitex-[0-9a-f+]+" core-partex/Cargo.toml | head -1)
src="$HOME/code/tmp/$pin/viewer/src"
dst=extension/src/vendor/viewer
[ -d "$src" ] || { echo "no $src (export the pinned engine commit there)" >&2; exit 1; }
if [ "${1:-}" = "--check" ]; then
  diff -r "$src" "$dst" > /dev/null || { echo "extension/src/vendor/viewer differs from $pin's viewer/src: run scripts/vendor-viewer.sh" >&2; exit 1; }
  echo "viewer: as $pin"
  exit 0
fi
rm -rf "$dst"
mkdir -p "$dst"
cp "$src"/*.ts "$dst"/
echo "viewer: copied from $pin ($(ls "$dst" | wc -l) files)"
