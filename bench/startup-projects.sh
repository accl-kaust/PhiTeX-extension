#!/usr/bin/env bash
# Dev only: the six arXiv e-prints bench/startup-all.sh opens, unpacked into
# target/startup/projects/<name> (not committed: the authors' sources).
# Picked from the package survey (target/arxiv-packages/results.jsonl) as a
# median paper of each class by package count and packages outside the bundle,
# plus a XeLaTeX one (00README.json: "compiler": "xelatex") and the paper with
# the most packages outside the bundle (longtail). One request per 4 s.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p target/startup/eprints target/startup/projects
while read -r name id; do
  f=target/startup/eprints/$id.raw
  [ -s "$f" ] || { curl -fsSL -A "phitex-package-survey/1.0 (research; rate-limited)" -o "$f" "https://export.arxiv.org/src/$id"; sleep 4; }
  rm -rf "target/startup/projects/$name"; mkdir -p "target/startup/projects/$name"
  tar xzf "$f" -C "target/startup/projects/$name" 2>/dev/null || gunzip -c "$f" > "target/startup/projects/$name/main.tex"
  echo "$name $id: $(du -sh "target/startup/projects/$name" | cut -f1)"
done <<'LIST'
article 2610.02048
revtex 2610.00844
ieeetran 2610.02175
acmart 2610.01884
xelatex 2610.02072
longtail 2610.01909
LIST
