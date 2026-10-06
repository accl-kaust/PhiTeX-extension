#!/usr/bin/env bash
# Take Shelf's current release (schema 3: every file by its texmf path) into
# the extension, as the index it ships (the fallback; newer releases are
# fetched by the extension itself, src/release.ts): its index as
# shelf-index.tsv.gz and its release.json (the engines' search paths and
# deps columns, which the index is read by: src/resolve.ts) as
# shelf-release.json. Run after Shelf's release.py, and deploy Shelf before
# shipping an extension with it.
#   scripts/shelf-index.sh [path/to/shelf.PhiTeX.org] [label] [releases dir name]
set -euo pipefail
cd "$(dirname "$0")/.."
shelf="${1:-../shelf.PhiTeX.org}"; label="${2:-tl2026}"; releases="${3:-releases}"
rel="$shelf/$releases/$label"
read -r schema index < <(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["schema"], r["index"])' "$rel/release.json")
[ "$schema" = 3 ] || { echo "$rel/release.json: schema $schema, this extension reads 3" >&2; exit 1; }
cp "$rel/$index" shelf-index.tsv.gz
cp "$rel/release.json" shelf-release.json
echo "shelf-index.tsv.gz: $(gzip -dc shelf-index.tsv.gz | wc -l) paths, release $(basename "$index" .tsv.gz | sed 's/^index-//')"
