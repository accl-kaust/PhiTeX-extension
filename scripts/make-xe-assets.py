#!/usr/bin/env python3
"""XeTeX's assets, one file the worker loads for the first xelatex project.

    python3 scripts/make-xe-assets.py FMT_DIR OUT

OUT (gzip) holds `u32 n, (u32 len, name, u32 len, bytes) x n`, little-endian,
as make-assets.py's: FMT_DIR's xelatex.fmt and fontindex.pxfi (mkfmt with
MKFMT_XETEX, the engine's otf-index), TeX Live's dvipdfmx.cfg (xdvipdfmx's
configuration), and its TECkit mappings (.tec: fontspec's Mapping=tex-text),
which Shelf does not carry (fonts/misc).
"""
import gzip, struct, sys
from pathlib import Path

fmt_dir, out = Path(sys.argv[1]), sys.argv[2]
tl = Path("/usr/share/texmf-dist")
files = {
    "xelatex.fmt": (fmt_dir / "xelatex.fmt").read_bytes(),
    "fontindex.pxfi": (fmt_dir / "fontindex.pxfi").read_bytes(),
    "dvipdfmx.cfg": (tl / "dvipdfmx/dvipdfmx.cfg").read_bytes(),
}
for f in sorted((tl / "fonts/misc/xetex/fontmapping").rglob("*.tec")):
    files.setdefault(f.name, f.read_bytes())
b = bytearray(struct.pack("<I", len(files)))
for n, data in files.items():
    nb = n.encode()
    b += struct.pack("<I", len(nb)) + nb + struct.pack("<I", len(data)) + data
Path(out).write_bytes(gzip.compress(bytes(b), 9, mtime=0))
print(f"{out}: {len(files)} files, {len(b) / 1e6:.1f} MB, {Path(out).stat().st_size / 1e6:.2f} MB gzipped")
