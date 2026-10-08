#!/usr/bin/env python3
"""data/arxiv-papers.tsv.gz from extract.py's OUT/papers-*.jsonl and fetch.py's
ids (their sample: "survey1", the first survey's 1020; "fresh", drawn per
category past the newest 150). One paper a row; lists comma-separated.
  python3 bench/arxiv/papers.py OUT [data/arxiv-papers.tsv.gz]
Columns: id, cat, sample, status, class (the main file's, local or not),
engine (what the sources need: an unconditional fontspec & co. is xelatex,
see extract.py), declared (arXiv's 00README compiler, or "-"), classes,
packages, bst (from TeX Live, not shipped by the paper), local (what it ships),
built ("ok:PAGES" when the extension's core built it, build-packs.mjs; "error";
"-" not built), built_packs (the Shelf packs that build read, fonts included)."""
import glob, gzip, json, os, sys
out = sys.argv[1]
dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "../../data/arxiv-papers.tsv.gz")
sample = {}
for l in open(os.path.join(out, "..", "all-ids.txt")) if os.path.exists(os.path.join(out, "..", "all-ids.txt")) else []:
    p = l.rstrip("\n").split("\t")
    sample[p[0]] = p[2] if len(p) > 2 else "?"
recs = []
for f in sorted(glob.glob(os.path.join(out, "papers-*.jsonl"))):
    recs += [json.loads(l) for l in open(f)]
recs.sort(key=lambda r: r["id"])
built = {}
for f in sorted(glob.glob(os.path.join(out, "built-*.jsonl"))):
    for l in open(f):
        b = json.loads(l); built[b["id"]] = b
cols = ["id", "cat", "sample", "status", "class", "engine", "declared", "classes", "packages", "bst", "local", "built", "built_packs"]
with gzip.open(dst, "wt") as w:
    w.write("\t".join(cols) + "\n")
    for r in recs:
        if r["status"] != "ok": continue
        eng = r.get("engine_guess", "pdflatex")
        row = [r["id"], r["cat"], sample.get(r["id"], "?"), r["status"], r.get("class") or "-", eng,
               r.get("engine") if r.get("engine_from") == "readme" else "-",
               ",".join(r.get("classes", [])), ",".join(r.get("packages", [])), ",".join(r.get("bst", [])), ",".join(r.get("local", []))]
        b = built.get(r["id"])
        # (built: what the core's build read, bench/arxiv/build-packs.mjs: "ok" with its pages, "error", or "-" not built)
        row += ["-", ""] if not b else [("ok:%s" % b.get("pages")) if b.get("ok") and b.get("pages") else "error", ",".join(b.get("packs", []))]
        w.write("\t".join(row) + "\n")
st = {}
for r in recs: st[r["status"]] = st.get(r["status"], 0) + 1
print(dst, st)
