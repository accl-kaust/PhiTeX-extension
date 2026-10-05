#!/usr/bin/env bash
# Build the extension into extension/ (load that directory unpacked).
#
#   scripts/build.sh          # release
#   scripts/build.sh --dev    # also match the local mock (http://localhost:<any port>/project/*)
#   scripts/build.sh --phitex # PhiTeX's core instead of partex's
#
# The wasm core: cargo for wasm32-wasip1, in the sandbox (PhiTeX read-only),
# target dir inside this repo. No wasm-bindgen: the core has a raw C ABI
# and the worker its own WASI shim (see REPORT.md, "Why wasip1").
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="$PWD/target"

# The core: partex-PhiTeX's pdfTeX (core-partex/, real LaTeX), or with
# --phitex PhiTeX's (core/). Either is a WASI reactor: link wasi-libc's
# crt1-reactor.o, whose `_initialize` (run once by the host) runs libc's
# constructors. A cdylib gets no crt of its own (rustc's -Zwasi-exec-model
# applies to binaries only), and without it std's thread-local destructor
# registration spins forever.
engine=partex
for a in "$@"; do [ "$a" = "--phitex" ] && engine=phitex; done
sysroot=$(scripts/sandbox rustc --print sysroot)
flags="-C target-feature=+bulk-memory,+simd128,+nontrapping-fptoint,+sign-ext -C link-arg=$sysroot/lib/rustlib/wasm32-wasip1/lib/self-contained/crt1-reactor.o -C link-arg=--export=_initialize"
rm -rf extension/dist && mkdir -p extension/dist
if [ $engine = partex ]; then
  (cd core-partex && CARGO_TARGET_DIR="$PWD/../target/partex" ../scripts/sandbox env CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="$flags" \
    cargo build --release --target wasm32-wasip1)
  cp target/partex/wasm32-wasip1/release/phitex_overleaf_partex.wasm extension/dist/core.wasm
  # The LaTeX format, made by the same engine (mkfmt), and the fonts'
  # metrics: one gzipped file the worker hands the core.
  if [ ! -f target/fmt/pdflatex.fmt ]; then
    (cd core-partex && CARGO_TARGET_DIR="$PWD/../target/partex" ../scripts/sandbox cargo build --release --bin mkfmt)
    (ulimit -v 8000000; scripts/sandbox target/partex/release/mkfmt target/fmt texmf)
  fi
  scripts/sandbox python3 scripts/make-assets.py target/fmt/pdflatex.fmt extension/dist/assets.bin.gzdata
else
  (cd core && ../scripts/sandbox env CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="$flags" \
    cargo build --release --target wasm32-wasip1)
  cp target/wasm32-wasip1/release/phitex_overleaf_core.wasm extension/dist/core.wasm
fi
# (the full license, shipped in the extension, where its links point)
# (the Shelf packs most documents load, shipped: data/bundled-packs.txt)
scripts/bundle-packs.sh
cp LICENSE extension/LICENSE.txt
cp NOTICE extension/NOTICE.txt
# The bundled packages (scripts/fetch-texmf.sh), flat by name: shelf.ts reads
# them before asking Shelf.
rm -rf extension/texmf && cp -r texmf extension/texmf
# Shelf's index (name -> pack), made by Shelf's build: scripts/shelf-index.sh
# (named .gzdata: Edge's store refuses archives inside a package)
cp shelf-index.tsv.gz extension/shelf-index.tsv.gzdata
scripts/sandbox npx tsc -p .
# Latin Modern (GUST Font License), the fonts the pages are drawn in (page2.ts)
lm=/usr/share/texmf-dist/fonts/opentype/public
rm -rf extension/fonts && mkdir -p extension/fonts
cp $lm/lm/lmroman10-{regular,bold,italic,bolditalic}.otf $lm/lm/lmmono10-regular.otf $lm/lm-math/latinmodern-math.otf extension/fonts/
# pdf.js (Apache-2.0), the PDF-mode page renderer (pdfrender.ts)
mkdir -p extension/dist/pdfjs && cp node_modules/pdfjs-dist/build/pdf.min.mjs node_modules/pdfjs-dist/build/pdf.worker.min.mjs node_modules/pdfjs-dist/LICENSE extension/dist/pdfjs/
# minted: Pyodide (Python in wasm), the engine's latexminted runner, and TeX
# Live's four wheels (latexminted, latexrestricted, latex2pydata, Pygments);
# bundled, loaded by the worker only for a project that uses minted
mkdir -p extension/dist/pyodide extension/dist/minted extension/minted
cp node_modules/pyodide/{pyodide.mjs,pyodide.asm.mjs,pyodide.asm.wasm,pyodide-lock.json,package.json} extension/dist/pyodide/
# (.data, not .zip or .whl: Edge's store refuses archives inside a package)
cp node_modules/pyodide/python_stdlib.zip extension/dist/pyodide/python_stdlib.data
rm -f extension/minted/*.whl
partex_dir=$(sed -n 's|^partex-core = { path = "\(.*\)/crates/partex-core" }|\1|p' core-partex/Cargo.toml)
cp "core-partex/$partex_dir/tools/minted-pyodide/runner.mjs" extension/dist/minted/
: > extension/minted/wheels.txt
for w in /usr/share/texmf-dist/scripts/minted/*.whl; do cp "$w" "extension/minted/$(basename "$w").data"; basename "$w" >> extension/minted/wheels.txt; done
echo "minted: $(du -sh extension/dist/pyodide | cut -f1) Pyodide, $(wc -l < extension/minted/wheels.txt) wheels"

# The manifest: manifest.base.json, plus (--dev) the local mock's origin.
dev=false; for a in "$@"; do [ "$a" = "--dev" ] && dev=true; done
# (the engine's commit, from the pin, as version_name: debug reports name it)
engine=$(grep -oE "partex-phitex-[0-9a-f]+" core-partex/Cargo.toml | head -1 | sed 's/partex-phitex-//')
scripts/sandbox node -e '
  const fs = require("fs"), m = JSON.parse(fs.readFileSync("extension/manifest.base.json"));
  m.version_name = `${m.version} (engine ${process.argv[2]})`;
  if (process.argv[1] === "true") {
    for (const c of m.content_scripts) c.matches.push("http://localhost/project/*");
    m.web_accessible_resources[0].matches.push("http://localhost/*");
  }
  fs.writeFileSync("extension/manifest.json", JSON.stringify(m, null, 2) + "\n");' "$dev" "$engine"
# (--dev: Shelf from a local server, ../shelf.PhiTeX.org/serve.py)
$dev && sed -i 's|https://shelf-phitex.pages.dev/|http://localhost:8124/|' extension/dist/shelf.js
# Every module the content script imports must be web-accessible.
scripts/sandbox node -e '
  const fs = require("fs"), m = JSON.parse(fs.readFileSync("extension/manifest.json"));
  const listed = new Set(m.web_accessible_resources.flatMap((w) => w.resources));
  const seen = new Set(), todo = ["dist/content-main.js"];
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const [, dep] of fs.readFileSync("extension/" + f, "utf8").matchAll(/^import [^;]*? from "\.\/([^"]+)";/gm)) todo.push("dist/" + dep);
  }
  const missing = [...seen].filter((f) => !listed.has(f));
  if (missing.length) { console.error("not in web_accessible_resources:", missing.join(" ")); process.exit(1); }'
ls -la extension/dist/core.wasm
