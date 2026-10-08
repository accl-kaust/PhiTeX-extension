#!/usr/bin/env python3
"""arXiv e-prints for the package survey, politely (dev only; Python 3.8+,
stdlib only, runs on the accl cluster).

  fetch.py list OUT/ids.txt [--seed target/arxiv-packages/ids.txt]
      ids to fetch: the original survey's (--seed, "id<TAB>cat") plus a fresh
      sample per category from the arXiv API (one query each, 3 s apart).
  fetch.py get OUT IDS --shard K --of N [--gap S]
      the ids whose line number is K mod N: each e-print from
      export.arxiv.org/e-print/ID, keeping only its text sources (.tex, .sty,
      .cls, .bbl, .ltx, 00README*: no figures) as OUT/src/ID.tar.gz, and a
      status line in OUT/status-K.tsv. S seconds between requests (shards
      run in parallel: N shards at gap S make N/S requests per second in all;
      keep that at most 1/3). Resumable: an id with a status is skipped.
"""
import gzip, io, os, sys, tarfile, time, urllib.request, urllib.parse, re

UA = "phitex-package-survey/1.0 (research; rate-limited)"
CATS = {
    # (fresh sample: per category, skipping the newest `skip` the first survey took)
    "cs.LG": 160, "cs.CV": 120, "cs.CL": 120, "cs.AI": 100, "cs.RO": 60, "cs.CR": 60, "cs.IT": 40,
    "cs.DS": 40, "cs.NI": 40, "cs.HC": 40, "cs.LO": 30, "cs.SE": 40, "cs.DC": 40, "cs.AR": 30, "cs.PL": 30,
    "cs.IR": 40, "cs.GT": 30, "cs.CG": 25, "cs.SI": 30, "cs.MA": 25,
    "math.AP": 40, "math.CO": 40, "math.PR": 40, "math.NT": 30, "math.AG": 30, "math.OC": 40, "math.NA": 40,
    "math.DG": 30, "math.GT": 25, "math.RT": 25, "math.ST": 30, "math.FA": 30, "math.DS": 30, "math.LO": 20,
    "math.QA": 20, "math.GR": 20,
    "hep-th": 50, "hep-ph": 50, "hep-ex": 25, "hep-lat": 20, "gr-qc": 40, "nucl-th": 25, "quant-ph": 70,
    "cond-mat.str-el": 30, "cond-mat.mtrl-sci": 40, "cond-mat.mes-hall": 35, "cond-mat.stat-mech": 30,
    "cond-mat.soft": 25, "cond-mat.supr-con": 20,
    "astro-ph.GA": 35, "astro-ph.CO": 30, "astro-ph.SR": 30, "astro-ph.HE": 30, "astro-ph.EP": 25, "astro-ph.IM": 20,
    "physics.optics": 30, "physics.flu-dyn": 30, "physics.chem-ph": 25, "physics.comp-ph": 20, "physics.app-ph": 20,
    "physics.bio-ph": 20, "physics.soc-ph": 15,
    "eess.SP": 40, "eess.SY": 40, "eess.IV": 30, "eess.AS": 25,
    "stat.ME": 40, "stat.ML": 40, "stat.AP": 25, "q-bio.NC": 20, "q-bio.QM": 20, "q-bio.BM": 15,
    "q-fin.ST": 15, "q-fin.MF": 15, "econ.EM": 20, "econ.TH": 15, "nlin.CD": 15,
}
SKIP = 150  # the first survey took the newest 20..90 per category; start past them
KEEP = re.compile(r"(\.(tex|sty|cls|bbl|ltx|clo|cfg|def|bst|latex)$|(^|/)00README)", re.I)


def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read(), r.headers.get("Content-Type", "")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None, "404"
            if e.code in (429, 503):
                time.sleep(60 * (i + 1))
                continue
            if i == tries - 1:
                raise
            time.sleep(20)
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(20)
    return None, "giveup"


def cmd_list(out, seed):
    seen, rows = set(), []
    if seed:
        for l in open(seed):
            p = l.split()
            if p and p[0] not in seen:
                seen.add(p[0]); rows.append((p[0], p[1] if len(p) > 1 else "?", "survey1"))
    for cat, n in CATS.items():
        q = urllib.parse.urlencode({"search_query": "cat:" + cat, "sortBy": "submittedDate", "sortOrder": "descending",
                                    "start": SKIP, "max_results": n})
        body, _ = get("https://export.arxiv.org/api/query?" + q)
        ids = re.findall(r"<id>https?://arxiv.org/abs/([^<]+?)(?:v\d+)?</id>", (body or b"").decode("utf-8", "replace"))
        k = 0
        for i in ids:
            if i not in seen:
                seen.add(i); rows.append((i, cat, "fresh")); k += 1
        print(cat, len(ids), k, flush=True)
        time.sleep(3.5)
    with open(out, "w") as f:
        for r in rows:
            f.write("\t".join(r) + "\n")
    print(len(rows), "ids")


def texts(data):
    """The e-print's text sources: [(name, bytes)], and its kind."""
    raw = data
    try:
        raw = gzip.decompress(data)
    except OSError:
        pass
    if raw[:4] == b"%PDF":
        return [], "pdf-only"
    try:
        t = tarfile.open(fileobj=io.BytesIO(raw))
        out = []
        for m in t.getmembers():
            if m.isfile() and KEEP.search(m.name) and m.size < 8 << 20:
                out.append((m.name, t.extractfile(m).read()))
        return out, "tar"
    except tarfile.TarError:
        return [("main.tex", raw)], "single"


def cmd_get(out, ids, k, n, gap):
    os.makedirs(os.path.join(out, "src"), exist_ok=True)
    st = os.path.join(out, "status-%d.tsv" % k)
    # (done by any shard, of this or an earlier split: the split can change between runs)
    done = set()
    for f in os.listdir(out):
        if f.startswith("status-") and f.endswith(".tsv"):
            done |= {l.split("\t")[0] for l in open(os.path.join(out, f))}
    rows = [l.split("\t") for l in open(ids) if l.strip()]
    mine = [r for i, r in enumerate(rows) if i % n == k and r[0] not in done]
    print("shard %d/%d: %d to fetch" % (k, n, len(mine)), flush=True)
    with open(st, "a") as log:
        for r in mine:
            pid = r[0]
            t = time.time()
            try:
                data, ct = get("https://export.arxiv.org/e-print/" + pid)
                if data is None:
                    status, files = "missing:" + ct, []
                else:
                    files, status = texts(data)
            except Exception as e:
                status, files = "error:" + type(e).__name__, []
            if files:
                buf = io.BytesIO()
                with tarfile.open(fileobj=buf, mode="w:gz") as tf:
                    for name, b in files:
                        ti = tarfile.TarInfo(name.lstrip("./") or "x")
                        ti.size = len(b)
                        tf.addfile(ti, io.BytesIO(b))
                with open(os.path.join(out, "src", pid.replace("/", "_") + ".tar.gz"), "wb") as f:
                    f.write(buf.getvalue())
            log.write("%s\t%s\t%s\t%d\t%d\n" % (pid, r[1].strip(), status, len(files), len(data or b"")))
            log.flush()
            time.sleep(max(0, gap - (time.time() - t)))


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[0] == "list":
        cmd_list(a[1], a[a.index("--seed") + 1] if "--seed" in a else None)
    elif a[0] == "get":
        cmd_get(a[1], a[2], int(a[a.index("--shard") + 1]), int(a[a.index("--of") + 1]),
                float(a[a.index("--gap") + 1]) if "--gap" in a else 12.0)
