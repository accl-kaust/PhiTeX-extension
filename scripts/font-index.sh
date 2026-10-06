#!/usr/bin/env bash
# XeTeX's font index (the engine's otf-index) over the fonts Shelf serves,
# not this machine's TeX Live: every face the index names is then one the
# extension can fetch, at the same /usr/share/texmf-dist/fonts/... path.
# Shelf's current release's font files are unpacked into a tree, which a
# bwrap mounts over fonts/opentype and fonts/truetype while otf-index runs
# fc-list over them. Writes target/fmt-xe/fontindex.pxfi (and drops
# xelatex.fmt, made with it, so build.sh makes it again).
#   scripts/font-index.sh [path/to/shelf.PhiTeX.org] [label]
set -euo pipefail
cd "$(dirname "$0")/.."
shelf="${1:-$HOME/code/flinner/shelf.PhiTeX.org}"
label="${2:-tl2026}"
partex_root=$(sed -n 's|^partex-core = { path = "\(.*\)/crates/partex-core" }|\1|p' core-partex/Cargo.toml)
engine="$(cd "core-partex/$partex_root" && pwd)"
tree=target/shelf-fonts
rm -rf "$tree"
mkdir -p "$tree" target/fmt-xe
python3 - "$shelf/releases/$label" "$tree" <<'EOF'
import gzip, json, struct, sys
from pathlib import Path
rel, out = Path(sys.argv[1]), Path(sys.argv[2])
index = json.loads((rel / "release.json").read_text())["index"]
rows = [l.split("\t") for l in gzip.decompress((rel / index).read_bytes()).decode().splitlines()]
want = {r[0]: r[1] for r in rows if r[0].startswith(("fonts/opentype/", "fonts/truetype/"))}
n = 0
for pid in sorted(set(want.values())):
    b = gzip.decompress((rel / "h" / f"{pid}.pack").read_bytes())
    (count,) = struct.unpack_from("<I", b, 0)
    i = 4
    for _ in range(count):
        (k,) = struct.unpack_from("<I", b, i); name = b[i + 4 : i + 4 + k].decode(); i += 4 + k
        (m,) = struct.unpack_from("<I", b, i); data = b[i + 4 : i + 4 + m]; i += 4 + m
        if name in want:
            p = out / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            n += 1
print(f"{index}: {n} of {len(want)} font files", file=sys.stderr)
EOF
(cd "$engine" && scripts/sandbox cargo build -q -p partex-otf --release --example otf-index)
out="$PWD/target/fmt-xe"
bwrap --unshare-all --die-with-parent --ro-bind / / \
  --ro-bind "$PWD/$tree/fonts/opentype" /usr/share/texmf-dist/fonts/opentype \
  --ro-bind "$PWD/$tree/fonts/truetype" /usr/share/texmf-dist/fonts/truetype \
  --tmpfs /tmp --dev /dev --proc /proc --bind "$out" "$out" --chdir "$engine" \
  "$engine/target/release/examples/otf-index" "$out/fontindex.pxfi"
rm -f target/fmt-xe/xelatex.fmt
