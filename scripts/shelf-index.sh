#!/usr/bin/env bash
# Take Shelf's current release's index (name -> content-named pack) into the
# extension, as the index it ships (the fallback; newer releases are fetched
# by the extension itself, src/release.ts): run after Shelf's release.py,
# and deploy Shelf before shipping an extension with it.
#   scripts/shelf-index.sh [path/to/shelf.PhiTeX.org] [label]
set -euo pipefail
cd "$(dirname "$0")/.."
shelf="${1:-../shelf.PhiTeX.org}"; label="${2:-tl2026}"
rel="$shelf/releases/$label"
index=$(scripts/sandbox python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["index"])' "$rel/release.json" 2>/dev/null || python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["index"])' "$rel/release.json")
cp "$rel/$index" shelf-index.tsv.gz
echo "shelf-index.tsv.gz: $(gzip -dc shelf-index.tsv.gz | wc -l) names, release $(basename "$index" .tsv.gz | sed 's/^index-//')"
