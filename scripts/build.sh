#!/usr/bin/env bash
# Build the extension into extension/ (load that directory unpacked).
#
#   scripts/build.sh          # release
#   scripts/build.sh --dev    # also match the local mock (http://localhost:8123/project/*)
#
# The wasm core: cargo for wasm32-wasip1, in the sandbox (PhiTeX read-only),
# target dir inside this repo. No wasm-bindgen: the core has a raw C ABI
# and the worker its own WASI shim (see REPORT.md, "Why wasip1").
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="$PWD/target"

# A WASI reactor: link wasi-libc's crt1-reactor.o, whose `_initialize` (run
# once by the host) runs libc's constructors. A cdylib gets no crt of its
# own (rustc's -Zwasi-exec-model applies to binaries only), and without it
# std's thread-local destructor registration spins forever.
sysroot=$(cd core && scripts_sandbox=../scripts/sandbox && $scripts_sandbox rustc --print sysroot)
flags="-C link-arg=$sysroot/lib/rustlib/wasm32-wasip1/lib/self-contained/crt1-reactor.o -C link-arg=--export=_initialize"
(cd core && ../scripts/sandbox env CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="$flags" \
  cargo build --release --target wasm32-wasip1)
rm -rf extension/dist && mkdir -p extension/dist
cp target/wasm32-wasip1/release/phitex_overleaf_core.wasm extension/dist/core.wasm
scripts/sandbox npx tsc -p .

# The manifest: manifest.base.json, plus (--dev) the local mock's origin.
dev=false; [ "${1:-}" = "--dev" ] && dev=true
scripts/sandbox node -e '
  const fs = require("fs"), m = JSON.parse(fs.readFileSync("extension/manifest.base.json"));
  if (process.argv[1] === "true") {
    for (const c of m.content_scripts) c.matches.push("http://localhost:8123/project/*");
    m.web_accessible_resources[0].matches.push("http://localhost:8123/*");
  }
  fs.writeFileSync("extension/manifest.json", JSON.stringify(m, null, 2) + "\n");' "$dev"
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
