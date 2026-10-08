// The built core.wasm under node:wasi, through the same framing as the worker.
import { WASI } from "node:wasi";
import fs from "node:fs";
export async function core(path = new URL("../overleaf/dist/core.wasm", import.meta.url)) {
  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(path), { wasi_snapshot_preview1: wasi.wasiImport });
  wasi.initialize(instance);
  const e = instance.exports, enc = new TextEncoder(), dec = new TextDecoder();
  const frame = (items) => {
    const parts = items.map((x) => typeof x === "number" ? new Uint8Array(new Uint32Array([x]).buffer) : (() => { const b = enc.encode(x); return [new Uint8Array(new Uint32Array([b.length]).buffer), b]; })()).flat();
    const len = parts.reduce((a, b) => a + b.length, 0), p = e.ph_alloc(len);
    let at = 0; for (const b of parts) { new Uint8Array(e.memory.buffer, p + at, b.length).set(b); at += b.length; }
    return [p, len];
  };
  const out = () => new Uint8Array(e.memory.buffer, e.ph_out_ptr(), e.ph_out_len()).slice();
  const json = () => JSON.parse(dec.decode(out()));
  return {
    e, out, json,
    open(files, main, fuel = 1_000_000) { const h = e.ph_open(...frame([fuel, main, Object.keys(files).length, ...Object.entries(files).flat()])); return { h, ...json() }; },
    edit(h, file, start, end, text, page = -1, dpi = 72) { const ok = e.ph_edit(h, ...frame([file, start, end, text]), page < 0 ? 0xffffffff : page, dpi); return { ok, ...json() }; },
    status(h) { e.ph_status(h); return json(); },
    check(h) { e.ph_check(h); return json(); },
    png(h, k, dpi = 72) { e.ph_png(h, k, dpi); return out(); },
    pdf(h) { e.ph_pdf(h); return out(); },
  };
}
