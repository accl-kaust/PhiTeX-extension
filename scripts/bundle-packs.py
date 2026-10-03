#!/usr/bin/env python3
"""data/bundled-packs.txt: the Shelf packs of the N packages and M classes
arXiv papers use most (data/arxiv-packages.tsv, data/arxiv-classes.tsv, from
the package survey), each with the packs its loading reads (Shelf's index:
dependencies and fonts).  python3 scripts/bundle-packs.py [N=100] [M=15]"""
import gzip, sys
from pathlib import Path
root = Path(__file__).resolve().parent.parent
N, M = (int(a) for a in (sys.argv[1:] + ["100", "15"])[:2])
idx = {}
for l in gzip.open(root / "extension/shelf-index.tsv.gz", "rt"):
    p = l.rstrip("\n").split("\t")
    if len(p) >= 2:
        idx[p[0]] = [p[1]] + (p[2].split(",") if len(p) > 2 and p[2] else [])
def top(f, n):
    return [l.split("\t")[0] for l in (root / f).read_text().splitlines()[1 : n + 1]]
packs = set()
for name in [p + ".sty" for p in top("data/arxiv-packages.tsv", N)] + [c + ".cls" for c in top("data/arxiv-classes.tsv", M)]:
    packs.update(idx.get(name, []))
(root / "data/bundled-packs.txt").write_text("\n".join(sorted(packs)) + "\n")
print(f"{len(packs)} packs")
