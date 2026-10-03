#!/usr/bin/env bash
# The partex core as a WASI reactor (see scripts/build.sh for why crt1-reactor.o).
set -euo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="$PWD/../target/partex"
sysroot=$(../scripts/sandbox rustc --print sysroot)
flags="-C link-arg=$sysroot/lib/rustlib/wasm32-wasip1/lib/self-contained/crt1-reactor.o -C link-arg=--export=_initialize"
../scripts/sandbox env CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="$flags" cargo build --release --target wasm32-wasip1
ls -la "$CARGO_TARGET_DIR/wasm32-wasip1/release/phitex_overleaf_partex.wasm"
