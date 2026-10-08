#!/usr/bin/env python3
"""Which arXiv papers the extension can build with no Shelf fetch, and the
smallest pack sets that would cover more (dev only; stdlib).

  python3 bench/arxiv/coverage.py [data/arxiv-papers.tsv.gz] [--sets data/arxiv-sets] [--subset survey1|fresh]

A paper (data/arxiv-papers.tsv.gz, bench/arxiv/: fetch.py, extract.py,
papers.py) needs its class, packages and bibliography style, each resolved
by the extension's rule (src/resolve.ts: the engine's search prefixes in
shelf-release.json, then the smallest path) to a file of Shelf's index
(shelf-index.tsv.gz), which needs its pack and the packs its loading reads
with that engine (the index's deps column: pdftex or xetex; LuaLaTeX's taken
as XeTeX's). A name the extension has without a pack (texmf/names.txt, the
core's assets-names.txt) needs nothing. A name nowhere in TeX Live (a
misspelling, a private style the paper did not ship) makes the paper
unbuildable by any set: such papers are counted apart.

Covered by a set of packs: every pack a paper needs is in it. Sizes are the
.pack files' (gzip, what is shipped or downloaded), from SHELF_RELEASES
(default ~/code/flinner/shelf.PhiTeX.org/releases-s3/tl2026/h), else
extension/packs/, else a HEAD request to Shelf.

Prints: the share covered by the bundled packs (extension/packs/list.txt);
the greedy curve (papers covered against MB, adding each step the paper
whose missing packs weigh least) from nothing and from the current bundle;
the sets reaching 90/95/98/99% with their size, font share and closure.
--sets DIR: each such set's packs as DIR/pNN.txt (from nothing) and
DIR/bundle+pNN.txt (what to add to the bundle).
"""
import gzip, json, os, sys, urllib.request

root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
args = sys.argv[1:]
papers_path = next((a for a in args if not a.startswith("--") and (args.index(a) == 0 or not args[args.index(a) - 1].startswith("--"))), os.path.join(root, "data/arxiv-papers.tsv.gz"))
opt = lambda k: args[args.index(k) + 1] if k in args else None
SETS, SUBSET = opt("--sets"), opt("--subset")
REL = os.environ.get("SHELF_RELEASES", os.path.expanduser("~/code/flinner/shelf.PhiTeX.org/releases-s3")) + "/tl2026/h"

meta = json.load(open(os.path.join(root, "shelf-release.json")))
ENG = meta["deps"]  # (the deps columns: pdftex, xetex)
rows, by_base, pack_paths = {}, {}, {}
for l in gzip.open(os.path.join(root, "shelf-index.tsv.gz"), "rt"):
    p = l.rstrip("\n").split("\t")
    if len(p) < 2 or not p[0]: continue
    rows[p[0]] = (p[1], [d.split(",") if d else [] for d in p[2:]])
    by_base.setdefault(p[0].rsplit("/", 1)[-1], []).append(p[0])
    pack_paths.setdefault(p[1], []).append(p[0])
for v in by_base.values(): v.sort()
have = set(open(os.path.join(root, "extension/texmf/names.txt")).read().split()) | set(open(os.path.join(root, "extension/dist/assets-names.txt")).read().split())
bundled = set(open(os.path.join(root, "extension/packs/list.txt")).read().split())
# (src/resolve.ts formatOf: the kpathsea format by extension)
FMT = {"tfm": "tfm", "vf": "vf", "pfb": "type1", "pfa": "type1", "enc": "enc", "map": "map", "otf": "opentype", "ttf": "truetype",
       "ttc": "truetype", "bst": "bst", "csf": "bst", "bib": "bib", "ist": "ist", "tec": "misc"}


def resolve(name, eng):
    paths = by_base.get(name)
    if not paths: return None
    pre = meta["search"].get(eng, {}).get(FMT.get(name.rsplit(".", 1)[-1].lower(), "tex"))
    if not pre: return paths[0]
    for x in pre:
        x = x if x.endswith("/") else x + "/"
        for p in paths:
            if p.startswith(x): return p
    return None


def name_packs(n, eng):
    """(path, packs) of a name for an engine (Shelf's: pdftex, xetex, luatex), as the extension fetches it."""
    path = resolve(n, eng)
    if not path: return None, set()
    col = ENG.index("xetex" if eng == "luatex" else eng)
    own, deps = rows[path]
    return path, {own, *(deps[col] if col < len(deps) else [])}


def needs(names, engine, per=None):
    eng = {"xelatex": "xetex", "lualatex": "luatex"}.get(engine, "pdftex")
    packs, unknown = set(), []
    for n in names:
        path, ps = name_packs(n, eng)
        if n in have and not (path and path.startswith(("tex/xelatex/", "tex/lualatex/", "tex/xetex/", "tex/luatex/"))): continue
        if not path:
            unknown.append(n); continue
        packs |= ps
        if per is not None: per.append((n, eng, ps))
    return packs, unknown


_size = {}
def size(pid):
    if pid in _size: return _size[pid]
    for d in (REL, os.path.join(root, "extension/packs")):
        f = os.path.join(d, pid + ".pack")
        if os.path.exists(f):
            _size[pid] = os.path.getsize(f); return _size[pid]
    try:
        r = urllib.request.urlopen(urllib.request.Request("https://shelf-phitex.pages.dev/tl2026/h/%s.pack" % pid, method="HEAD"), timeout=30)
        _size[pid] = int(r.headers.get("Content-Length") or 0)
    except Exception:
        _size[pid] = 0
    return _size[pid]


def is_font(pid):
    ps = pack_paths.get(pid, [])
    return bool(ps) and sum(p.startswith("fonts/") for p in ps) * 2 > len(ps)


# ---- the papers ----
P = []
with gzip.open(papers_path, "rt") as f:
    head = f.readline().rstrip("\n").split("\t")
    for l in f:
        r = dict(zip(head, l.rstrip("\n").split("\t")))
        if SUBSET and r.get("sample") != SUBSET: continue
        names = [c + ".cls" for c in r["classes"].split(",") if c] + [p + ".sty" for p in r["packages"].split(",") if p] + [b + ".bst" for b in r["bst"].split(",") if b]
        per = []
        packs, unknown = needs(names, r["engine"], per)
        # (what the core's build read, fonts included: added when the paper was built)
        bp = set(x for x in r.get("built_packs", "").split(",") if x)
        # (a .bst TeX Live lacks: the paper ships its .bbl (arXiv's tarballs do), not needed to build)
        unknown = [n for n in unknown if not n.endswith(".bst")]
        # (built with pages out: what that build read is what the paper needs, fonts included; else the closure of its names)
        built_ok = r.get("built", "-").startswith("ok")
        P.append({"id": r["id"], "engine": r["engine"], "packs": bp if built_ok else packs, "closure": packs, "built": r.get("built", "-"), "unknown": unknown, "per": per})
N = len(P)
ok = [p for p in P if not p["unknown"]]
NB = len(ok)
MB = lambda b: b / 1e6
print(f"# arXiv coverage ({os.path.basename(papers_path)}{', ' + SUBSET if SUBSET else ''})\n")
print(f"papers: {N}; buildable from TeX Live (every name in Shelf's index): {len(ok)} ({100*len(ok)/N:.1f}%); "
      f"engines: " + ", ".join(f"{e} {sum(p['engine']==e for p in P)}" for e in sorted({p['engine'] for p in P})))
nb = sum(1 for p in P if p["built"].startswith("ok"))
print(f"built by the core (build-packs.mjs, pages out): {nb} ({100*nb/N:.1f}%); for the rest only the index's closure counts (fonts the text is set in not seen)")
extra = [len(p["packs"] - p["closure"]) for p in P if p["built"].startswith("ok")]
less = [len(p["closure"] - p["packs"]) for p in P if p["built"].startswith("ok")]
if extra: print(f"a build against the closure of its names: read {sum(extra)/len(extra):.1f} packs more (fonts, mostly; median {sorted(extra)[len(extra)//2]}), {sum(less)/len(less):.1f} fewer (loaded only under options, or after an error); the build's set is used")
cov = sum(1 for p in ok if p["packs"] <= bundled)
cov_cl = sum(1 for p in ok if p["closure"] <= bundled)
print(f"covered by the bundle by the closure alone (no build): {cov_cl} ({100*cov_cl/N:.1f}%)")
print(f"\nbundled packs: {len(bundled)}, {MB(sum(size(x) for x in bundled)):.1f} MB")
print(f"fully covered by the bundle (texmf/ + core assets + bundled packs): {cov} of {N} papers ({100*cov/N:.1f}%), {100*cov/len(ok):.1f}% of the buildable")
miss = {}
for p in ok:
    for x in p["packs"] - bundled: miss[x] = miss.get(x, 0) + 1
print("packs most often missing from the bundle: " + ", ".join(f"{k.rsplit('-',1)[0]} ({v})" for k, v in sorted(miss.items(), key=lambda kv: -kv[1])[:25]))
un = {}
for p in P:
    for n in p["unknown"]: un[n] = un.get(n, 0) + 1
print("names not in TeX Live (top): " + ", ".join(f"{k} ({v})" for k, v in sorted(un.items(), key=lambda kv: -kv[1])[:15]))


# The best small additions to the bundle: each step the pack that completes the
# most papers per MB (papers missing only it, given the steps before)
print("\n## Small additions to the bundle, best first\n")
print("| + pack | KB | fonts | papers it completes | covered after (of the buildable) | added MB |")
print("|---|---|---|---|---|---|")
S2, tot = set(bundled), 0
base_cov = sum(1 for p in ok if p["packs"] <= S2)
for step in range(25):
    cnt = {}
    for p in ok:
        m = p["packs"] - S2
        if len(m) == 1:
            x = next(iter(m)); cnt[x] = cnt.get(x, 0) + 1
    if not cnt: break
    x = max(cnt, key=lambda k: (cnt[k] / max(size(k), 20000), cnt[k]))
    S2.add(x); tot += size(x)
    cov2 = sum(1 for p in ok if p["packs"] <= S2)
    print(f"| {x.rsplit('-', 1)[0]} | {size(x)/1e3:.0f} | {'yes' if is_font(x) else ''} | {cnt[x]} | {100*cov2/NB:.1f}% | {MB(tot):.2f} |")


def greedy(start):
    """[(MB, papers covered, packs added)]: each step adds what completes the most papers per MB:
    either the one pack some papers lack alone, or the cheapest paper's missing packs."""
    S = set(start)
    rem = [set(p["packs"]) - S for p in ok]
    cost = [sum(size(x) for x in r) for r in rem]
    inv = {}
    for i, r in enumerate(rem):
        for x in r: inv.setdefault(x, []).append(i)
    ones = {}
    for r in rem:
        if len(r) == 1: x = next(iter(r)); ones[x] = ones.get(x, 0) + 1
    done = [not r for r in rem]
    base = sum(size(x) for x in S)
    cur, curve, order, papers = base, [(MB(base), sum(done), 0)], [], []
    def add(x):
        nonlocal cur
        S.add(x); order.append(x); cur += size(x)
        for j in inv.get(x, []):
            if x in rem[j]:
                if len(rem[j]) == 1: ones[x] -= 1
                rem[j].discard(x); cost[j] -= size(x)
                if len(rem[j]) == 1:
                    y = next(iter(rem[j])); ones[y] = ones.get(y, 0) + 1
                if not rem[j] and not done[j]:
                    done[j] = True; papers.append(j)
    while not all(done):
        i = min((j for j in range(len(ok)) if not done[j]), key=lambda j: (cost[j], -len(rem[j])))
        best1 = max((k for k in ones if ones[k] > 0), key=lambda k: ones[k] / max(size(k), 1), default=None)
        if best1 is not None and ones[best1] / max(size(best1), 1) >= 1 / max(cost[i], 1):
            add(best1)
        else:
            for x in sorted(rem[i]): add(x)
        curve.append((MB(cur), sum(done), len(order)))
    greedy.papers = papers
    return curve, order


def report(curve, order, start, label):
    print(f"\n## Greedy from {label}\n")
    print("| covered (of the buildable) | MB | packs | of them fonts (MB) |")
    print("|---|---|---|---|")
    out = {}
    for q in (0.5, 0.75, 0.8, 0.9, 0.95, 0.98, 0.99):
        hit = next(((mb, c, k) for mb, c, k in curve if c >= q * NB), None)
        if not hit:
            print(f"| {int(q*100)}% | unreachable (max {100*curve[-1][1]/NB:.1f}%) | | |"); continue
        mb, c, k = hit
        packs = set(start) | set(order[:k])
        fonts = sum(size(x) for x in packs if is_font(x))
        print(f"| {int(q*100)}% ({c}) | {mb:.1f} | {len(packs)} | {MB(fonts):.1f} |")
        out[q] = packs
    # (the curve itself, at round MB steps)
    pts, last = [], -1
    for mb, c, k in curve:
        if int(mb // 5) != last:
            last = int(mb // 5); pts.append(f"{mb:.0f} MB {100*c/NB:.1f}%")
    print("\ncurve: " + " · ".join(pts) + f" · {curve[-1][0]:.0f} MB {100*curve[-1][1]/NB:.1f}%")
    return out


c0, o0 = greedy(set())
s0 = report(c0, o0, set(), "nothing")
c1, o1 = greedy(bundled)
s1 = report(c1, o1, bundled, "the current bundle")
if SETS:
    os.makedirs(SETS, exist_ok=True)
    for q, packs in s0.items():
        open(os.path.join(SETS, f"p{int(q*100)}.txt"), "w").write("\n".join(sorted(packs)) + "\n")
    for q, packs in s1.items():
        open(os.path.join(SETS, f"bundle+p{int(q*100)}.txt"), "w").write("\n".join(sorted(packs - bundled)) + "\n")


AHEAD = opt("--ahead")
if AHEAD:
    # The names prefetch.ts fetches ahead (each resolved through the index: its
    # packs and their deps, the bundled ones skipped), in the greedy order from the
    # bundle, until 95% of all papers are covered whole. A font pack a build read
    # that no name's closure brings is named by one of its files (a .tfm first).
    greedy(bundled)
    order_papers = greedy.papers
    S, lines, seen, target = set(bundled), [], set(), 0.95 * NB
    covered = sum(1 for p in ok if p["packs"] <= S)
    def rep_file(pid):
        ps = sorted(pack_paths.get(pid, []), key=lambda x: (not x.endswith(".tfm"), not x.endswith(".pfb"), x))
        for x in ps:
            b = x.rsplit("/", 1)[-1]
            if resolve(b, "pdftex") == x and b not in have: return b
        return None
    for i in order_papers:
        if covered >= target: break
        p = ok[i]
        if p["packs"] <= S: continue
        for n, eng, ps in p["per"]:
            if ps <= S: continue
            key = (n, eng)
            if key not in seen:
                seen.add(key); lines.append(n + ("\t" + eng if eng != "pdftex" else ""))
            S |= ps
        for pid in sorted(p["packs"] - S):
            f = rep_file(pid)
            if f and (f, "pdftex") not in seen:
                seen.add((f, "pdftex")); lines.append(f)
                S |= name_packs(f, "pdftex")[1]
            S.add(pid)
        covered = sum(1 for q in ok if q["packs"] <= S)
    extra = S - bundled
    mb = MB(sum(size(x) for x in extra))
    fonts = MB(sum(size(x) for x in extra if is_font(x)))
    with open(AHEAD, "w") as f:
        f.write(f"# fetched ahead by prefetch.ts, most papers' first (bench/arxiv/coverage.py --ahead: {len(lines)} names, "
                f"{len(extra)} packs, {mb:.1f} MB beyond the bundle, {fonts:.1f} MB of it fonts; {100*covered/NB:.1f}% of {NB} buildable arXiv papers covered whole)\n")
        f.write("\n".join(lines) + "\n")
    print(f"\nahead list: {AHEAD}: {len(lines)} names, {len(extra)} packs beyond the bundle, {mb:.1f} MB ({fonts:.1f} MB fonts), covers {100*covered/NB:.1f}% of the buildable")
