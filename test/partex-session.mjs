// The partex core (wasm) through its ph_* ABI under node:wasi, as the worker
// drives it: a 20-page article opened (packages from texmf/), then edits,
// each timed.  node test/partex-session.mjs CORE.wasm ASSETS.bin.gz
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { WASI } from "node:wasi";
const [wasmPath, assetsPath] = process.argv.slice(2);
const wasi = new WASI({ version: "preview1", args: [], env: {} });
const inst = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(wasmPath)), { wasi_snapshot_preview1: wasi.wasiImport });
wasi.initialize(inst);
const x = inst.exports, enc = new TextEncoder(), dec = new TextDecoder();
const frame = (parts) => {
  const bufs = parts.map((p) => (typeof p === "number" ? new Uint8Array(new Uint32Array([p]).buffer) : (() => { const b = enc.encode(p); return [new Uint8Array(new Uint32Array([b.length]).buffer), b]; })())).flat();
  const n = bufs.reduce((a, b) => a + b.length, 0), ptr = x.ph_alloc(n), m = new Uint8Array(x.memory.buffer, ptr, n);
  let at = 0;
  for (const b of bufs) { m.set(b, at); at += b.length; }
  return [ptr, n];
};
const out = () => dec.decode(new Uint8Array(x.memory.buffer, x.ph_out_ptr(), x.ph_out_len()));
const a = gunzipSync(readFileSync(assetsPath));
const p = x.ph_alloc(a.length);
new Uint8Array(x.memory.buffer, p, a.length).set(a);
console.log("assets", x.ph_assets(p, a.length));
let main = "\\documentclass{article}\n\\begin{document}\n";
for (let k = 0; k < 40; k++) {
  main += `\\section{Section ${k}}\n`;
  for (let q = 0; q < 4; q++) main += `Paragraph ${q} of section ${k}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.\n\n`;
}
main += "\\end{document}\n";
const h = x.ph_open(...frame([0, "main.tex", 1, "main.tex", main]));
const asked = new Set();
for (;;) {
  x.ph_status(h);
  const st = JSON.parse(out());
  const want = st.missing.filter((n) => !asked.has(n));
  if (!want.length) { console.log(`opened: ${st.pages} pages, ${st.how}, ${st.build_ms.toFixed(0)} ms`); break; }
  for (const n of want) {
    asked.add(n);
    try { x.ph_set_file(h, ...frame([n, readFileSync("texmf/" + n, "utf8")])); } catch {}
  }
}
for (const k of [30, 5, 12]) {
  const at = enc.encode(main.slice(0, main.indexOf(`Paragraph 2 of section ${k}.`))).length;
  main = main.replace(`Paragraph 2 of section ${k}.`, `Paragraf 2 of section ${k}.`);
  const t = performance.now();
  x.ph_edit(h, ...frame(["main.tex", at, at + 9, "Paragraf"]), 0, 0);
  const e = JSON.parse(out());
  x.ph_status(h);
  const st = JSON.parse(out());
  console.log(`edit in section ${k}: ${(performance.now() - t).toFixed(0)} ms in all; ${st.how}`);
}
