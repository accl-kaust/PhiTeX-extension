#!/usr/bin/env bash
# The Chrome Web Store upload: a release build of extension/, zipped.
#   scripts/package.sh        → store/phitex-instant-<version>.zip
# Checks: the release manifest (no localhost), only what the extension
# runs (no sources, tests or maps), the wasm core and the license in.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/build.sh
version=$(scripts/sandbox node -p 'require("./extension/manifest.json").version')
out="store/phitex-instant-$version.zip"
mkdir -p store
rm -f "$out"

if grep -q localhost extension/manifest.json; then echo "manifest has localhost: not a release build" >&2; exit 1; fi
files=(manifest.json popup.html offscreen.html LICENSE.txt icons dist texmf shelf-index.tsv.gz)
for f in "${files[@]}"; do [ -e "extension/$f" ] || { echo "missing extension/$f" >&2; exit 1; }; done
[ -s extension/dist/core.wasm ] || { echo "no core.wasm" >&2; exit 1; }
[ -s extension/texmf/names.txt ] || { echo "no texmf/ (scripts/fetch-texmf.sh)" >&2; exit 1; }
[ -s extension/shelf-index.tsv.gz ] || { echo "no shelf-index.tsv.gz (scripts/shelf-index.sh)" >&2; exit 1; }
if grep -q localhost extension/dist/shelf.js; then echo "shelf.js points at localhost: not a release build" >&2; exit 1; fi
if find extension/dist -name '*.map' | grep -q .; then echo "source maps in dist" >&2; exit 1; fi

(cd extension && scripts_zip=1 zip -q -r -X "../$out" "${files[@]}")
echo "$out ($(du -h "$out" | cut -f1))"
unzip -l "$out" | tail -n +4 | head -n -2 | awk '{print "  " $4}'
