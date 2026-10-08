#!/usr/bin/env bash
# Dev only: bench/startup.mjs over the six arXiv-shaped projects
# (target/startup/projects/<name>, from bench/startup-projects.sh), on a fast
# and an emulated slow network, each cold / restart / reload; then the table.
#   bench/startup-all.sh [names...]        (PHITEX_REPS="2 3": repeats, NAME-NET-rN; PHITEX_NETS="fast slow")
set -uo pipefail
cd "$(dirname "$0")/.."
names=("$@"); [ ${#names[@]} -eq 0 ] && names=(article revtex ieeetran acmart xelatex longtail)
run() { timeout 900 systemd-run --user --scope -q --slice=partex.slice -p MemoryMax=16G -p MemorySwapMax=0 nice -n 19 ionice -c3 \
  scripts/sandbox --net node bench/startup.mjs "$@"; }
for net in ${PHITEX_NETS:-fast slow}; do
  flag=; [ $net = slow ] && flag=--slow
  for rep in ${PHITEX_REPS:-0}; do
    r=; [ "$rep" != 0 ] && r="--rep $rep"
    for n in "${names[@]}"; do
      run target/startup/projects/$n $n $flag $r
      # (XeLaTeX itself, not the pdfLaTeX approximation "auto" picks)
      [ $n = xelatex ] && run target/startup/projects/$n xelatex-xe $flag $r --xelatex
    done
  done
done
scripts/sandbox python3 bench/startup-analyze.py --path
