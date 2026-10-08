#!/usr/bin/env python3
"""Dev only: the stage breakdown of bench/startup.mjs's runs.

  python3 bench/startup-analyze.py [target/startup] [--md]

Every time is ms from the navigation (T0). A row per run (project, network,
phase): when the content script connects, the offscreen document and the
build worker (A) start, the worker's stages (wasm compile, the Shelf index
read and parsed, the assets fetched and gunzipped, handed to the core), the
project's ZIP, the prefetch (with where its packs came from), the build
(build_ms, and how much of it was the core waiting for packs it fetched
itself, one synchronous request after another), the first paint.
"""
import json, os, re, sys, glob

root = next((a for a in sys.argv[1:] if not a.startswith("--")), "target/startup")
MD = "--md" in sys.argv


def kind(url):
    if url.startswith("chrome-extension://"):
        if "/packs/" in url and url.endswith(".pack"): return "bundled"
        return "ext"
    if "shelf-phitex" in url:
        return "shelf" if url.endswith(".pack") else "shelf-meta"
    if "/download/zip" in url: return "zip"
    return "other"


def analyze(r):
    T0 = r["T0"]
    o = {"phase": r["phase"]}
    o["paint"] = r["paint"] and round(r["paint"]["paint"])
    marks = {}
    for m in r["page"]["marks"]:
        t, _, k = m.partition(" ")
        if t.isdigit(): marks.setdefault(k.split(" ")[0], int(t) + r["page"]["origin"] - T0)
    o["connect"] = marks.get("connect") and round(marks["connect"])
    o["connected"] = marks.get("connected") and round(marks["connected"])
    o["offscreen"] = r["offscreenAttached"]
    # (the page's marks are its last 30: a project of many files pushes "connect" out; the offscreen document starts 5 ms after it)
    if o["connect"] is None and o["offscreen"] and o["offscreen"] > 0: o["connect"] = o["offscreen"] - 5
    if o["connect"] is None:
        cm = next((n for n in r["net"] if n["url"].endswith("/dist/content-main.js") and n["start"] >= 0), None)
        if cm: o["connect"] = round(cm["start"])
    # the build worker A: the first unnamed worker with marks after T0 (in a reload, the old one)
    ws = [w for w in r["workers"] if w["phx"] and w["name"] != "draw"]
    def rel(w, t): return w["origin"] + t - T0
    A = None
    for w in ws:
        if any(m["k"] == "ph_open" and rel(w, m["t0"]) >= 0 for m in w["phx"]["marks"]):
            A = w; break
    tr = r["cs"].get("trace", [])
    base = (r["cs"].get("origin") or 0) + (r["cs"].get("t0") or 0) - T0
    ev = lambda k: next((e for e in tr if e["k"] == k), None)
    ps, pd, so, ro = ev("prefetch: start"), ev("prefetch: done"), ev("→ open"), ev("← open")
    o["prefetch_start"] = ps and round(base + ps["t"])
    o["prefetch_ms"] = pd and pd["d"]["ms"]
    o["prefetch_files"] = pd and pd["d"]["files"]
    o["open_sent"] = so and round(base + so["t"])
    o["open_back"] = ro and round(base + ro["t"])
    o["build_ms"] = ro and ro["d"].get("build_ms")
    o["missing"] = ro and ro["d"].get("missing")
    o["pages"] = ro and ro["d"].get("pages")
    o["rounds_after_open"] = sum(1 for e in tr if e["k"] == "packages: want")
    # worker stages (A's own load, if it loaded in this phase)
    def first(w, k, after=0):
        return next((m for m in w["phx"]["marks"] if m["k"] == k and rel(w, m["t0"]) >= after), None) if w else None
    if A:
        c = first(A, "compile"); inst = first(A, "instantiate"); assets = first(A, "ph_assets")
        body = next((m for m in A["phx"]["marks"] if m["k"] == "body" and m["n"] > 3e7 and rel(A, m["t0"]) >= 0), None)
        net_assets = next((n for n in A["phx"]["net"] if "assets.bin" in n["url"] and rel(A, n["t0"]) >= 0), None)
        idx = next((m for m in A["phx"]["marks"] if m["k"] == "text" and m["n"] > 1e6 and rel(A, m["t0"]) >= 0), None)
        if c:
            o["compile_start"] = round(rel(A, c["t0"])); o["compile_ms"] = round(c["t1"] - c["t0"])
        if c and inst:
            o["shelf_index_ms"] = round(inst["t0"] - c["t1"])  # (index fetched, gunzipped, parsed: loadShelf)
            o["index_parse_ms"] = idx and round(inst["t0"] - idx["t1"])
        if net_assets and body:
            o["assets_ms"] = round(body["t1"] - net_assets["t0"])
        if assets:
            o["handoff_ms"] = round(assets["t1"] - assets["t0"]); o["worker_ready"] = round(rel(A, assets["t1"]))
        op = first(A, "ph_open")
        if op:
            o["build_start"] = round(rel(A, op["t0"])); o["ph_open_ms"] = round(op["t1"] - op["t0"])
            f = [m for m in A["phx"]["marks"] if m["k"] == "import.fetch" and op["t0"] <= m["t0"] <= op["t1"]]
            o["inbuild_fetch_ms"] = round(sum(m["t1"] - m["t0"] for m in f))
            sx = [n for n in A["phx"]["net"] if n.get("sync") and op["t0"] <= n["t0"] <= op["t1"]]
            o["inbuild_shelf"] = sum(1 for n in sx if "shelf-phitex" in n["url"])
            o["inbuild_shelf_ms"] = round(sum(n["t1"] - n["t0"] for n in sx if "shelf-phitex" in n["url"]))
            o["inbuild_bundled"] = sum(1 for n in sx if "/packs/" in n["url"] and n["url"].startswith("chrome-extension"))
    # network: bytes by kind (encoded; 0 from the disk cache)
    by = {}
    for n in r["net"]:
        if n.get("start") is None or n["start"] < 0: continue
        k = kind(n["url"])
        b = by.setdefault(k, [0, 0, 0])
        b[0] += 1; b[1] += n.get("bytes") or 0; b[2] += 1 if n.get("disk") or n.get("mem") else 0
    o["shelf_packs"] = by.get("shelf", [0])[0]; o["shelf_bytes"] = by.get("shelf", [0, 0])[1]; o["shelf_cached"] = by.get("shelf", [0, 0, 0])[2]
    o["bundled_packs"] = by.get("bundled", [0])[0]; o["bundled_bytes"] = by.get("bundled", [0, 0])[1]
    o["shelf_meta_bytes"] = by.get("shelf-meta", [0, 0])[1]
    z = next((n for n in r["net"] if kind(n["url"]) == "zip" and n["start"] >= 0), None)
    if z: o["zip"] = [round(z["start"]), round(z["end"] or 0), z.get("bytes")]
    o["unzipped"] = marks.get("unzipped") and round(marks["unzipped"])
    off = r.get("offscreen") or {}
    phx = off.get("phx") or {}
    if phx.get("idb"):
        i = phx["idb"]; o["idb_get"] = i["get"]; o["idb_hit"] = i["hit"]; o["idb_hit_bytes"] = i["hitBytes"]; o["idb_put"] = i["put"]; o["idb_put_bytes"] = i["putBytes"]
    o["idb_files_after"] = off.get("idbCount")
    # (the prefetch: the offscreen document's index read and parsed, then its packs)
    if phx.get("fetch") and o.get("prefetch_start") is not None:
        oo = off["origin"] - T0
        pk = [f for f in phx["fetch"] if f["url"].endswith(".pack") and oo + f["t0"] >= o["prefetch_start"] - 5]
        if pk:
            o["prefetch_index_ms"] = round(oo + pk[0]["t0"] - o["prefetch_start"])
            o["prefetch_packs_ms"] = round(o["open_sent"] - (oo + pk[0]["t0"]))
            o["prefetch_pack_requests"] = len([f for f in pk if oo + f["t0"] <= o["open_sent"]])
    # the critical path, stage by stage (ms)
    g = lambda k: o.get(k)
    try:
        o["path"] = {
            "page_to_cs": g("connect"),
            "cs_to_zip": o["zip"][0] - g("connect"),
            "zip": o["zip"][1] - o["zip"][0],
            "unzip_figures": g("prefetch_start") - o["zip"][1],
            "prefetch": g("open_sent") - g("prefetch_start"),
            "open_wait": g("build_start") - g("open_sent"),
            "build": g("ph_open_ms"),
            "reply": g("open_back") - g("build_start") - g("ph_open_ms"),
            "to_paint": g("paint") - g("open_back"),
        }
        o["worker_slack"] = g("open_sent") - g("worker_ready") if g("worker_ready") else None
    except Exception:
        pass
    return o


rows = []
for f in sorted(glob.glob(os.path.join(root, "*-*/*.json"))):
    tag = os.path.basename(os.path.dirname(f))
    try:
        r = json.load(open(f))
    except Exception:
        continue
    a = analyze(r); a["run"] = tag; rows.append(a)
cols = ["run", "phase", "paint", "connect", "offscreen", "compile_ms", "shelf_index_ms", "index_parse_ms", "assets_ms", "handoff_ms", "worker_ready",
        "zip", "unzipped", "prefetch_start", "prefetch_ms", "prefetch_files", "open_sent", "build_start", "build_ms", "inbuild_fetch_ms", "inbuild_shelf",
        "inbuild_shelf_ms", "open_back", "missing", "rounds_after_open", "pages", "shelf_packs", "shelf_bytes", "shelf_cached", "bundled_packs", "bundled_bytes",
        "shelf_meta_bytes", "idb_get", "idb_hit", "idb_hit_bytes", "idb_put", "idb_put_bytes", "idb_files_after"]
def med(xs):
    xs = sorted(x for x in xs if isinstance(x, (int, float)))
    return xs[len(xs) // 2] if xs else None
if "--summary" in sys.argv:
    # medians over repeats (NAME-NET[-rN]); times from the content script's start (connect), not the navigation
    groups = {}
    for a in rows:
        base = re.sub(r"-r\d+$", "", a["run"])
        groups.setdefault((base, a["phase"]), []).append(a)
    ks = ["cs_to_zip", "zip", "unzip_figures", "prefetch", "open_wait", "build", "to_paint"]
    print("| run | phase | n | first paint after CS start | " + " | ".join(ks) + " | build: waiting on Shelf | Shelf fetches in build | prefetch: index / packs | worker ready (after CS) | IDB put (files, MB) |")
    print("|" + "---|" * (len(ks) + 9))
    for (run, ph), xs in sorted(groups.items(), key=lambda kv: (kv[0][0].split("-")[-1], kv[0][0], ["cold", "restart", "reload"].index(kv[0][1]))):
        P = lambda k: med([x.get("path", {}).get(k) for x in xs])
        A = lambda k: med([x.get(k) for x in xs])
        tot = med([x["paint"] - x["connect"] for x in xs if x.get("paint") and x.get("connect")])
        wr = med([x["worker_ready"] - x["connect"] for x in xs if x.get("worker_ready") and x.get("connect")])
        pi = A("prefetch_index_ms"); pp = A("prefetch_packs_ms")
        idb = A("idb_put"); idbb = A("idb_put_bytes")
        print(f"| {run} | {ph} | {len(xs)} | {tot} | " + " | ".join(str(P(k)) for k in ks) +
              f" | {A('inbuild_shelf_ms')} | {A('inbuild_shelf')} | {pi if pi is not None else '-'} / {pp if pp is not None else '-'} | {wr if wr is not None else '-'} | {idb} ({(idbb or 0)/1e6:.1f}) |")
elif "--path" in sys.argv:
    ks = ["page_to_cs", "cs_to_zip", "zip", "unzip_figures", "prefetch", "open_wait", "build", "reply", "to_paint"]
    print("| run | phase | paint | " + " | ".join(ks) + " | of build: fetch waits | worker ready | worker slack |")
    print("|" + "---|" * (len(ks) + 6))
    for a in rows:
        p = a.get("path", {})
        print(f"| {a['run']} | {a['phase']} | {a.get('paint')} | " + " | ".join(str(p.get(k, '')) for k in ks) + f" | {a.get('inbuild_fetch_ms','')} | {a.get('worker_ready','')} | {a.get('worker_slack','')} |")
elif MD:
    print("| " + " | ".join(cols) + " |"); print("|" + "---|" * len(cols))
    for a in rows: print("| " + " | ".join(str(a.get(c, "")) for c in cols) + " |")
else:
    print(json.dumps(rows, indent=1))
