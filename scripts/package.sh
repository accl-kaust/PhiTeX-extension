#!/usr/bin/env bash
# The store uploads: a release build of extension/, zipped.
#   scripts/package.sh        → store/phitex-instant-<version>.zip (Chrome Web Store, Edge Add-ons)
#                               store/phitex-instant-<version>-firefox.zip (Firefox Add-ons)
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
files=(manifest.json popup.html offscreen.html LICENSE.txt NOTICE.txt icons fonts shims dist texmf packs minted shelf-index.tsv.gzdata)
for f in "${files[@]}"; do [ -e "extension/$f" ] || { echo "missing extension/$f" >&2; exit 1; }; done
[ -s extension/dist/core.wasm ] || { echo "no core.wasm" >&2; exit 1; }
[ -s extension/texmf/names.txt ] || { echo "no texmf/ (scripts/fetch-texmf.sh)" >&2; exit 1; }
[ -s extension/shelf-index.tsv.gzdata ] || { echo "no shelf-index.tsv.gzdata (scripts/shelf-index.sh, then build.sh)" >&2; exit 1; }
# (Edge refuses a package that holds archives)
if find extension/dist extension/minted extension/packs extension/texmf -name "*.zip" -o -name "*.gz" -o -name "*.whl" -o -name "*.tgz" | grep -q .; then echo "an archive in the package (Edge refuses it)" >&2; exit 1; fi
if grep -q localhost extension/dist/shelf.js; then echo "shelf.js points at localhost: not a release build" >&2; exit 1; fi
if find extension/dist -name '*.map' | grep -q .; then echo "source maps in dist" >&2; exit 1; fi

(cd extension && scripts_zip=1 zip -q -r -X "../$out" "${files[@]}")
echo "$out ($(du -h "$out" | cut -f1))"

# Firefox: no offscreen documents and no service worker; the background is a
# page that runs the core (firefox-bg.html), and an add-on id
fx="store/phitex-instant-$version-firefox.zip"
tmp="$PWD/target/fx-pack"; rm -rf "$tmp"; mkdir -p "$tmp"
(cd extension && cp -r "${files[@]}" firefox-bg.html "$tmp/")
scripts/sandbox python3 - "$tmp/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]; m = json.load(open(p))
m["permissions"] = [x for x in m["permissions"] if x != "offscreen"]
m.pop("minimum_chrome_version", None)
m["background"] = {"page": "firefox-bg.html"}
m["browser_specific_settings"] = {"gecko": {"id": "phitex-instant@phitex.org", "strict_min_version": "142.0",
    "data_collection_permissions": {"required": ["none"]}}}
json.dump(m, open(p, "w"), indent=2)
PY
rm -f "$fx"
(cd "$tmp" && zip -q -r -X - .) > "$fx"
rm -rf "$tmp"
echo "$fx ($(du -h "$fx" | cut -f1))"
unzip -l "$out" | tail -n +4 | head -n -2 | awk '{print "  " $4}'
