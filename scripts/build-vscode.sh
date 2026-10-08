#!/usr/bin/env bash
# The VS Code extension (vscode/): its three bundles (esbuild: the extension
# host's, the core's worker thread's, the webview's), and the browser build's
# files the shared code reads (overleaf/: run scripts/build.sh first): the
# core and latexdiff modules, the assets, texmf/, the packs, the fonts.
#
#   scripts/build-vscode.sh            # vscode/dist/, vscode/texmf/, ...
#   scripts/build-vscode.sh --package  # and vscode/phitex-instant-<v>.vsix
set -euo pipefail
cd "$(dirname "$0")/.."
[ -s overleaf/dist/core.wasm ] || { echo "no overleaf/dist/core.wasm: scripts/build.sh first" >&2; exit 1; }

scripts/sandbox bash -c 'cd vscode && ../node_modules/.bin/tsc -p .'
es=(node_modules/.bin/esbuild --bundle --log-level=warning --sourcemap=inline)
scripts/sandbox "${es[@]}" vscode/src/extension.ts --platform=node --format=cjs --target=node20 --external:vscode --outfile=vscode/dist/extension.js
scripts/sandbox "${es[@]}" vscode/src/worker.ts --platform=node --format=cjs --target=node20 --outfile=vscode/dist/worker.js
scripts/sandbox "${es[@]}" vscode/src/webview.ts --platform=browser --format=iife --target=es2022 --outfile=vscode/dist/webview.js

# (what the shared code reads, by the same paths as in the browser package)
for f in core.wasm diff.wasm assets.bin.gzdata assets-xelatex.bin.gzdata assets-names.txt; do
  cp overleaf/dist/$f vscode/dist/$f
done
for d in texmf packs fonts shims; do
  rm -rf "vscode/$d"
  cp -r "overleaf/$d" "vscode/$d"
done
cp overleaf/shelf-index.tsv.gzdata overleaf/shelf-release.json overleaf/LICENSE.txt overleaf/NOTICE.txt vscode/

if [ "${1:-}" = --package ]; then
  # (no source maps in the package)
  scripts/sandbox bash -c 'cd vscode && for f in extension worker webview; do ../node_modules/.bin/esbuild --bundle --log-level=warning src/$f.ts $([ $f = webview ] && echo --platform=browser --format=iife --target=es2022 || echo --platform=node --format=cjs --target=node20 --external:vscode) --outfile=dist/$f.js; done'
  scripts/sandbox --net bash -c 'cd vscode && npx --yes @vscode/vsce@3 package --no-dependencies --allow-missing-repository'
fi
du -sh vscode/dist vscode/texmf vscode/packs vscode/fonts 2>/dev/null
