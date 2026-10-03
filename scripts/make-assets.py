#!/usr/bin/env python3
"""The partex core's assets: the LaTeX format and the fonts' metrics, one file.

    python3 scripts/make-assets.py FMT OUT [TFM_DIR...]

OUT (gzip) holds `u32 n, (u32 len, name, u32 len, bytes) x n`, little-endian:
what `ph_assets` takes. The .tfm files are flat by name (first wins), as the
core looks them up. Default TFM dirs: TeX Live's cm, amsfonts, latex-fonts and ec (EC/TC:
T1 and TS1, \textbullet in itemize).
"""
import gzip, os, struct, sys
from pathlib import Path

fmt, out, *dirs = sys.argv[1:]
# (the extension's bundled packages too, texmf/: the LaTeX base every build
# reads, never a missing file to fetch)
bundle = Path(__file__).resolve().parent.parent / "texmf"
tl = "/usr/share/texmf-dist/fonts/tfm/public"
dirs = dirs or [f"{tl}/cm", f"{tl}/amsfonts", f"{tl}/latex-fonts", "/usr/share/texmf-dist/fonts/tfm/jknappen/ec"]
files = {"pdflatex.fmt": Path(fmt).read_bytes()}
# (the files the popular packages read, popular.txt, from a flat TeX Live:
# FLAT, default target/flat; scripts/popular.sh makes the list)
flat = Path(os.environ.get("FLAT", Path(__file__).resolve().parent.parent / "target/flat"))
pop = Path(__file__).resolve().parent.parent / "popular.txt"
# (and Knuth's Computer Modern in Type 1, AMS's: the base classes' fonts)
import re
cm = re.compile(r"cm(r|bx|ti|sl|tt|mi|mib|sy|bsy|ex|ss|ssi|ssbx|csc|u|b|bxsl|bxti|itt|sltt|tcsc|vtt|fi|ff|dunh|ssdc|ssq|ssqi|fib|tex)[0-9]+\.pfb")
for f in sorted(flat.glob("cm*.pfb")):
    if cm.fullmatch(f.name):
        files.setdefault(f.name, f.read_bytes())
if pop.exists():
    for n in pop.read_text().split():
        if (flat / n).is_file():
            files.setdefault(n, (flat / n).read_bytes())
for f in sorted(bundle.iterdir()):
    if f.is_file() and f.name not in ("names.txt", "MANIFEST.tsv"):
        files.setdefault(f.name, f.read_bytes())
for d in dirs:
    for f in sorted(Path(d).rglob("*.tfm")):
        files.setdefault(f.name, f.read_bytes())
b = bytearray(struct.pack("<I", len(files)))
for n, data in files.items():
    nb = n.encode()
    b += struct.pack("<I", len(nb)) + nb + struct.pack("<I", len(data)) + data
Path(out).parent.mkdir(parents=True, exist_ok=True)
Path(out).write_bytes(gzip.compress(bytes(b), 9))
# (their names, for the package loop: a name the core has is never fetched)
Path(out).with_name("assets-names.txt").write_text("".join(n + "\n" for n in sorted(files)))
print(f"{out}: {len(files)} files, {len(b)/1e6:.1f} MB, {Path(out).stat().st_size/1e6:.2f} MB gzipped", file=sys.stderr)
