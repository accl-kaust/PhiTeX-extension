#!/usr/bin/env python3
"""Each fetched e-print's class, engine and package set (dev only; Python
3.8+, stdlib only: runs on the accl cluster or here).

  extract.py OUT [--shard K --of N]
      reads OUT/status-*.tsv and OUT/src/ID.tar.gz (fetch.py's), writes
      OUT/papers-K.jsonl: one paper a line:
      {id, cat, status, class, engine, engine_from, packages, bst, local, unresolved_macros}

What a paper needs is read from its sources as a scan, not by running TeX:
- the main file: 00README.json's "toplevel" (or 00README.XXX's
  "toplevelfile"), else the .tex with \\documentclass and \\begin{document};
  the files it \\input/\\include/\\subfile (transitively), else every .tex;
- \\documentclass, \\usepackage, \\RequirePackage(WithOptions), \\LoadClass
  (comma lists; comments stripped), \\bibliographystyle; and, for a class
  or package the paper ships itself (local), what that file loads in turn;
- the engine: 00README.json's process.compiler (arXiv's own instruction,
  "engine_from": "readme"), else "% !TEX program" / "%!TeX TS-program",
  else a guess from the preamble (fontspec, unicode-math, polyglossia,
  xeCJK, ctex: xelatex; luacode, luatexja, \\directlua: lualatex), not
  counting a load inside \\ifxetex / \\iftutex / \\ifluatex / \\ifPDFTeX.
"""
import io, json, os, re, sys, tarfile, glob

NAME = re.compile(r"^[A-Za-z0-9@_.+-]+$")
LOAD = re.compile(r"\\(documentclass|LoadClass(?:WithOptions)?|usepackage|RequirePackage(?:WithOptions)?)\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}", re.S)
BST = re.compile(r"\\bibliographystyle\s*\{([^}]*)\}")
INPUT = re.compile(r"\\(?:input|include|subfile|subfileinclude|import\s*\{[^}]*\}|subimport\s*\{[^}]*\})\s*\{?\s*([^\s}]+)")
XE = re.compile(r"\b(fontspec|unicode-math|polyglossia|xeCJK|xltxtra|mathspec|xunicode|xepersian|bidi)\b")
LUA = re.compile(r"\b(luacode|luatexja|luaotfload|lua-visual-debug|luatexbase|lualatex-math|selnolig)\b")
GUARD = re.compile(r"\\if(xetex|XeTeX|tutex|luatex|LuaTeX|PDFTeX|pdftex|pdf)\b|\\ifdefined\\XeTeXrevision|\\ifx\\XeTeXrevision|IfFileExists\{fontspec|\\iftutex|\\sys_if_engine")


def strip(t):
    return re.sub(r"(?<!\\)%.*", "", t)


def readme(files):
    """(engine, toplevel) from arXiv's 00README.json / 00README.XXX / 00README.yaml."""
    eng = top = None
    for n, b in files.items():
        base = n.rsplit("/", 1)[-1]
        if not base.startswith("00README"): continue
        t = b.decode("utf-8", "replace")
        if base.endswith(".json"):
            try:
                j = json.loads(t)
                eng = (j.get("process") or {}).get("compiler") or eng
                for s in j.get("sources") or []:
                    if s.get("usage") == "toplevel": top = top or s.get("filename")
            except Exception:
                pass
        else:
            m = re.search(r"compiler\s*:\s*['\"]?(\w+)", t)
            if m: eng = m.group(1)
            for l in t.splitlines():
                p = l.split()
                if len(p) >= 2 and p[1] == "toplevelfile": top = top or p[0]
    return eng, top


def main_file(texs, top):
    if top and top in texs: return top
    cands = [n for n, t in texs.items() if re.search(r"^\s*\\documentclass", t, re.M)]
    withdoc = [n for n in cands if "\\begin{document}" in texs[n]]
    pool = withdoc or cands
    if not pool: return None
    # (the shallowest, then the biggest: a main file, not a figure's standalone)
    return sorted(pool, key=lambda n: (n.count("/"), -len(texs[n])))[0]


def reach(texs, main):
    seen, todo = set(), [main]
    names = {n: n for n in texs}
    for n in texs:
        names.setdefault(n[:-4], n)
        names.setdefault(n.rsplit("/", 1)[-1], n); names.setdefault(n.rsplit("/", 1)[-1][:-4], n)
    while todo:
        f = todo.pop()
        if f in seen: continue
        seen.add(f)
        d = f.rsplit("/", 1)[0] + "/" if "/" in f else ""
        for m in INPUT.finditer(texs[f]):
            x = m.group(1).strip().lstrip("./")
            for k in (x, x + ".tex", d + x, d + x + ".tex", x.rsplit("/", 1)[-1], x.rsplit("/", 1)[-1] + ".tex"):
                if k in names:
                    todo.append(names[k]); break
    return seen


def scan(texs, files):
    eng_readme, top = readme(files)
    main = main_file(texs, top)
    use = reach(texs, main) if main else set(texs)
    local = {}
    for n, b in files.items():
        base = n.rsplit("/", 1)[-1]
        if base.endswith((".sty", ".cls", ".bst", ".clo", ".def")): local[base] = b.decode("utf-8", "replace")
    out = {"main": main, "class": None, "packages": [], "bst": [], "local": []}
    need, loc = [], set()
    opt = []
    def take(text, top_level):
        for m in LOAD.finditer(text):
            cls = "lass" in m.group(1)
            # (a load only if the file is there: \IfFileExists{mtpro2.sty}{…\RequirePackage{mtpro2}}{}, \IfPackageAvailableTF{x}…)
            win = text[max(0, m.start() - 300):m.start()]
            # (in a class or package the paper ships: a load inside a definition or an option runs only when that does)
            if not top_level and re.search(r"\\(def|gdef|edef|newcommand|renewcommand|providecommand|DeclareOption)\b", text[text.rfind("\n", 0, m.start()) + 1:m.start()]):
                continue
            names = [n.strip() for n in m.group(2).split(",") if n.strip()]
            if any(re.search(r"\\(IfFileExists|IfPackageAvailable\w*|IfClassAvailable\w*|ifpackageavailable)\s*\{\s*" + re.escape(n) + r"(\.sty|\.cls)?\s*\}", win) for n in names):
                opt.extend(names)
                continue
            for n in m.group(2).split(","):
                n = n.strip()
                if not n or not NAME.match(n): continue
                n = n[:-4] if n.endswith((".sty", ".cls")) else n
                ext = ".cls" if cls else ".sty"
                if top_level and m.group(1) == "documentclass" and out["class"] is None: out["class"] = n
                need.append(n + ext)
        for m in BST.finditer(text):
            n = m.group(1).strip()
            if n and NAME.match(n): need.append(n + ".bst")
    pre = []
    for f in sorted(use):
        t = strip(texs[f]); take(t, f == main)
        pre.append(t if f != main else t.split("\\begin{document}")[0])
    # (local files: what they load, once each)
    i, seen = 0, set()
    while i < len(need):
        n = need[i]; i += 1
        if n in local and n not in seen:
            seen.add(n); loc.add(n); take(strip(local[n]), False)
    out["local"] = sorted(loc)
    ext = [n for n in dict.fromkeys(need) if n not in loc]
    out["packages"] = sorted(n[:-4] for n in ext if n.endswith(".sty"))
    out["classes"] = sorted(n[:-4] for n in ext if n.endswith(".cls"))
    out["bst"] = sorted(n[:-4] for n in ext if n.endswith(".bst"))
    out["optional"] = sorted(set(opt))
    # the engine
    allt = "\n".join(texs.values())
    magic = re.search(r"^\s*%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*(\w+)", allt, re.I | re.M)
    guess = "pdflatex"
    p = "\n".join(pre)
    for m in LOAD.finditer(p):
        names = m.group(2)
        guarded = bool(GUARD.search(p[max(0, m.start() - 600):m.start()]))
        if LUA.search(names) and not guarded: guess = "lualatex"; break
        if XE.search(names) and not guarded: guess = "xelatex"
    if re.search(r"\\documentclass(\[[^\]]*\])?\{ctex", p): guess = "xelatex"
    if re.search(r"\\directlua\b", p): guess = "lualatex"
    out["engine_guess"] = guess
    if eng_readme:
        out["engine"], out["engine_from"] = eng_readme.lower(), "readme"
    elif magic:
        out["engine"], out["engine_from"] = magic.group(1).lower(), "magic"
    else:
        out["engine"], out["engine_from"] = guess, "guess"
    return out


def one(path):
    files = {}
    with tarfile.open(path) as tf:
        for m in tf.getmembers():
            if m.isfile(): files[m.name.lstrip("./")] = tf.extractfile(m).read()
    texs = {n: b.decode("utf-8", "replace") for n, b in files.items() if n.lower().endswith((".tex", ".ltx", ".latex"))}
    return scan(texs, files)


if __name__ == "__main__":
    out = sys.argv[1]
    k = int(sys.argv[sys.argv.index("--shard") + 1]) if "--shard" in sys.argv else 0
    N = int(sys.argv[sys.argv.index("--of") + 1]) if "--of" in sys.argv else 1
    rows = []
    for f in sorted(glob.glob(os.path.join(out, "status-*.tsv"))):
        rows += [l.rstrip("\n").split("\t") for l in open(f) if l.strip()]
    rows.sort()
    dst = os.path.join(out, "papers-%d.jsonl" % k)
    with open(dst + ".part", "w") as w:
        for i, r in enumerate(rows):
            if i % N != k: continue
            pid, cat, status = r[0], r[1], r[2]
            rec = {"id": pid, "cat": cat, "status": status}
            src = os.path.join(out, "src", pid.replace("/", "_") + ".tar.gz")
            if status in ("tar", "single") and os.path.exists(src):
                try:
                    rec.update(one(src))
                    rec["status"] = "ok" if rec.get("main") else "no-main"
                except Exception as e:
                    rec["status"] = "error:" + type(e).__name__
            w.write(json.dumps(rec) + "\n")
    os.replace(dst + ".part", dst)
