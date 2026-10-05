#!/usr/bin/env bash
# The mock page's editor (mock/editor/): Overleaf's LaTeX grammar generated
# into a Lezer parser, and CodeMirror 6 bundled into mock/build/editor.js.
# Run through the sandbox: scripts/sandbox scripts/mock-editor.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p mock/build
cp mock/editor/tokens.mjs mock/build/tokens.mjs
npx lezer-generator mock/editor/latex.grammar -o mock/build/latex.mjs
npx esbuild mock/editor/editor.mjs --bundle --format=esm --log-level=warning --outfile=mock/build/editor.js
