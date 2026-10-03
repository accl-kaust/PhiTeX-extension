// The PDF after an edit, through the wasm core as the worker drives it:
// open, fetch what it asks for (from a flat TeX Live), go, idle (the SSA
// program, rebuilds prepared), one edit, then the PDF: whole (%%EOF)?
//   node test/partex-pdf-edit.mjs CORE.wasm ASSETS.bin.gz MAIN.tex FLAT_DIR [AT] [TEXT]
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { WASI } from "node:wasi";
const [wasmPath, assetsPath, mainPath, flat, at = "Every writer", text = "Hello. "] = process.argv.slice(2);
const wasi = new WASI({ version: "preview1", args: [], env: {} });
const inst = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(wasmPath)), { wasi_snapshot_preview1: wasi.wasiImport });
wasi.initialize(inst);
const x = inst.exports, enc = new TextEncoder(), dec = new TextDecoder();
const u32 = (v) => new Uint8Array(new Uint32Array([v]).buffer);
const frame = (parts) => {
  const bufs = parts.flatMap((p) => (typeof p === "number" ? [u32(p)] : p instanceof Uint8Array ? [p] : (() => { const b = enc.encode(p); return [u32(b.length), b]; })()));
  const n = bufs.reduce((a, b) => a + b.length, 0), ptr = x.ph_alloc(n), m = new Uint8Array(x.memory.buffer, ptr, n);
  let o = 0;
  for (const b of bufs) { m.set(b, o); o += b.length; }
  return [ptr, n];
};
const bytes = () => new Uint8Array(x.memory.buffer, x.ph_out_ptr() >>> 0, x.ph_out_len() >>> 0).slice();
const json = () => JSON.parse(dec.decode(bytes()));
const a = gunzipSync(readFileSync(assetsPath));
const p = x.ph_alloc(a.length);
new Uint8Array(x.memory.buffer, p, a.length).set(a);
x.ph_assets(p, a.length);
let main = readFileSync(mainPath, "utf8");
const h = x.ph_open(...frame([0, "main.tex", 1, "main.tex", main]));
const asked = new Set();
for (let round = 0; round < 50; round++) {
  x.ph_status(h);
  const want = json().missing.filter((n) => !asked.has(n));
  x.ph_go(h);
  if (!want.length) break;
  for (const n of want) {
    asked.add(n);
    const f = `${flat}/${n}`;
    if (existsSync(f)) x.ph_set_bytes(h, ...frame([n, readFileSync(f)]));
  }
}
while (x.ph_idle()) {}
const pdf = () => { x.ph_pdf(h); return bytes(); };
const tail = (b) => dec.decode(b.subarray(Math.max(0, b.length - 30))).replace(/\n/g, "⏎");
let b = pdf();
console.log(`before: ${b.length} bytes …${tail(b)}`);
const k = enc.encode(main.slice(0, main.indexOf(at))).length;
x.ph_edit(h, ...frame(["main.tex", k, k, text]), 0, 96);
console.log("edit:", JSON.stringify(json()).slice(0, 160));
b = pdf();
console.log(`after:  ${b.length} bytes …${tail(b)}`);
x.ph_log(h);
console.log(dec.decode(bytes()).split("\n").filter((l) => /^build \d+:/.test(l)).map((l) => l.slice(0, 110)).join("\n"));
process.exit(dec.decode(b.subarray(b.length - 8)).includes("%%EOF") ? 0 : 1);
