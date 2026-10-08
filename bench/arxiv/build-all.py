#!/usr/bin/env python3
"""build-packs.mjs over the extracted papers, P at a time (dev only; stdlib;
the accl cluster: one array task per shard).

  build-all.py OUT NODE EXT_DIR PACKS_DIR --shard K --of N [-P 8] [--timeout 300]

Reads OUT/papers-*.jsonl (extract.py), builds each "ok" paper of shard K
(by line number mod N) from OUT/src/ID.tar.gz with its main file and engine
(pdflatex, or xelatex when its sources need it; LuaLaTeX papers are built as
XeLaTeX ones, the nearest the core has), appends a JSON line a paper to
OUT/built-K.jsonl. Resumable: an id already there is skipped.
"""
import glob, json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

a = sys.argv[1:]
OUT, NODE, EXT, PACKS = a[:4]
opt = lambda k, d: a[a.index(k) + 1] if k in a else d
K, N, P, TO = int(opt("--shard", 0)), int(opt("--of", 1)), int(opt("-P", 8)), int(opt("--timeout", 300))
here = os.path.dirname(os.path.abspath(__file__))
recs = []
for f in sorted(glob.glob(os.path.join(OUT, "papers-*.jsonl"))):
    recs += [json.loads(l) for l in open(f)]
recs = [r for r in sorted(recs, key=lambda r: r["id"]) if r["status"] == "ok"]
mine = [r for i, r in enumerate(recs) if i % N == K]
dst = os.path.join(OUT, "built-%d.jsonl" % K)
done = set()
if os.path.exists(dst):
    done = {json.loads(l)["id"] for l in open(dst) if l.strip()}
mine = [r for r in mine if r["id"] not in done]
print("shard %d/%d: %d to build" % (K, N, len(mine)), flush=True)
w = open(dst, "a")


def one(r):
    eng = r.get("engine_guess", "pdflatex")
    eng = "xelatex" if eng in ("xelatex", "lualatex") else "pdflatex"
    src = os.path.join(OUT, "src", r["id"].replace("/", "_") + ".tar.gz")
    try:
        p = subprocess.run([NODE, "--max-old-space-size=4096", os.path.join(here, "build-packs.mjs"), EXT, PACKS, src, r.get("main") or "", eng],
                           capture_output=True, text=True, timeout=TO)
        line = (p.stdout.strip().splitlines() or ["{}"])[-1]
        res = json.loads(line) if line.startswith("{") else {"ok": False, "error": (p.stderr or "no output")[-300:]}
    except subprocess.TimeoutExpired:
        res = {"ok": False, "error": "timeout %ds" % TO}
    except Exception as e:
        res = {"ok": False, "error": repr(e)[:300]}
    res["id"] = r["id"]
    return res


with ThreadPoolExecutor(P) as ex:
    for res in ex.map(one, mine):
        w.write(json.dumps(res) + "\n"); w.flush()
