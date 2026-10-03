// A LaTeX document in the partex core (wasm), the extension's way: run,
// fetch what the job found missing (here: kpsewhich, standing in for
// Shelf), run again.  node test/partex-latex.mjs CORE.wasm FMT DOC.tex
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { WASI } from "node:wasi";
const [wasmPath, fmtPath, docPath] = process.argv.slice(2);
const wasi = new WASI({ version: "preview1", args: [], env: {} });
const inst = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(wasmPath)), { wasi_snapshot_preview1: wasi.wasiImport });
wasi.initialize(inst);
const x = inst.exports, enc = new TextEncoder(), dec = new TextDecoder();
const put = (b) => { const p = x.px_alloc(b.length); new Uint8Array(x.memory.buffer, p, b.length).set(b); return [p, b.length]; };
const file = (n, b) => x.px_set_file(...put(enc.encode(n)), ...put(b));
const out = (n) => { const p = x.px_output(...put(enc.encode(n))); return p ? new Uint8Array(x.memory.buffer, p, x.px_out_len()).slice() : null; };
file("pdflatex.fmt", readFileSync(fmtPath));
file("doc.tex", readFileSync(docPath));
const have = new Set(), fetched = [];
for (let pass = 1; pass <= 30; pass++) {
  const t0 = performance.now();
  const h = x.px_run(...put(enc.encode("&pdflatex doc")), 0);
  const ms = performance.now() - t0;
  const missing = dec.decode(out("(missing)") ?? new Uint8Array()).split("\n").filter(Boolean).filter((n) => !have.has(n));
  console.log(`pass ${pass}: history ${h}, ${ms.toFixed(0)} ms, missing: ${missing.join(" ") || "-"}`);
  if (!missing.length) break;
  for (const n of missing) {
    have.add(n);
    let p = "";
    try { p = execFileSync("kpsewhich", ["-engine=pdftex", n], { encoding: "utf8" }).trim(); } catch {}
    if (p) { file(n, readFileSync(p)); fetched.push(n); }
  }
}
console.log("fetched", fetched.length, fetched.join(" "));
const term = dec.decode(out("(term)"));
console.log(term.split("\n").slice(-8).join("\n"));
const pdf = out("doc.pdf");
if (pdf) writeFileSync("target/doc.pdf", pdf);
console.log("doc.pdf", pdf?.length ?? "none");
