// Dev only: the Shelf packs a paper's build really reads (fonts included),
// by building it with the extension's own core (dist/core.wasm, the
// worker's ABI) in Node, one fresh instance per paper, packs read from a
// local copy of Shelf's h/ (no network). The dependency closure in Shelf's
// index is what *loading* a package reads; a build also reads the fonts its
// text is set in (tfm, vf, pfb, .fd), which only a build shows.
//
//   node bench/arxiv/build-packs.mjs EXT_DIR PACKS_DIR SRC(dir|.tar.gz) MAIN ENGINE [FUEL]
//
// EXT_DIR: the built extension (dist/core.wasm, dist/assets*.gzdata, texmf/,
// shelf-index.tsv.gz… as in extension/, or a copy). Prints one JSON line:
// { ok, ms, pages, error, packs: [ids, in the order asked], unresolved: [names] }.
// Figures are not in the sources (the survey keeps text only): a missing
// figure is an error the build goes on past, as Overleaf's nonstop mode does.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";

const [extDir, packsDir, src, mainArg, engine = "pdflatex", fuelArg] = process.argv.slice(2);
const FUEL = +(fuelArg ?? 400_000_000);
const enc = new TextEncoder(), dec = new TextDecoder();
const t0 = performance.now();

// ---- the index and the rule (src/resolve.ts) ----
const meta = JSON.parse(fs.readFileSync(path.join(extDir, "shelf-release.json"), "utf8"));
const indexFile = fs.existsSync(path.join(extDir, "shelf-index.tsv.gz")) ? path.join(extDir, "shelf-index.tsv.gz") : path.join(extDir, "shelf-index.tsv.gzdata");
const rows = new Map(), byBase = new Map();
for (const l of gunzipSync(fs.readFileSync(indexFile)).toString().split("\n")) {
  const [p, pack, ...deps] = l.split("\t");
  if (!p || !pack) continue;
  rows.set(p, { pack, deps: deps.map((d) => (d ? d.split(",") : [])) });
  const b = p.slice(p.lastIndexOf("/") + 1);
  (byBase.get(b) ?? byBase.set(b, []).get(b)).push(p);
}
for (const v of byBase.values()) v.sort();
const TL = "/usr/share/texmf-dist/";
function resolvePath(name, format, eng) {
  if (name.includes("/")) {
    const p = name.startsWith(TL) ? name.slice(TL.length) : name.replace(/^\.\//, "");
    return rows.has(p) ? p : null;
  }
  const paths = byBase.get(name);
  if (!paths) return null;
  const pre = meta.search?.[eng]?.[format];
  if (!pre) return paths[0];
  for (const x of pre) {
    const hit = paths.find((p) => p.startsWith(x.endsWith("/") ? x : x + "/"));
    if (hit) return hit;
  }
  return null;
}
const bundledNames = new Set(fs.readFileSync(path.join(extDir, "texmf/names.txt"), "utf8").split("\n").filter(Boolean));
const bundledPacks = new Set(fs.existsSync(path.join(extDir, "packs/list.txt")) ? fs.readFileSync(path.join(extDir, "packs/list.txt"), "utf8").split("\n").filter(Boolean) : []);

// ---- the sources ----
let dir = src;
if (src.endsWith(".tar.gz")) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-"));
  execFileSync("tar", ["xzf", src, "-C", dir]);
}
const files = {};
const walk = (d, rel = "") => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const r = rel ? `${rel}/${f.name}` : f.name;
    if (f.isDirectory()) walk(path.join(d, f.name), r);
    else if (/\.(tex|sty|cls|bbl|bst|bib|clo|cfg|def|ltx|fd|tikz|pgf|txt)$/i.test(f.name)) files[r] = fs.readFileSync(path.join(d, f.name), "utf8");
  }
};
walk(dir);
if (src.endsWith(".tar.gz")) fs.rmSync(dir, { recursive: true, force: true });

// ---- the core ----
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const str = (s) => { const b = Buffer.from(enc.encode(s)); return [u32(b.length), b]; };
const framed = (parts) => Buffer.concat([u32(parts.length), ...parts.flatMap((p) => [u32(p.length), p])]);
let mem, fetched;
const asked = [], unresolved = [];
const EBADF = 8, ENOSYS = 52;
const mod = new WebAssembly.Module(fs.readFileSync(path.join(extDir, "dist/core.wasm")));
const s = (p, n) => dec.decode(new Uint8Array(mem.buffer, p >>> 0, n >>> 0));
const phitex = {
  resolve(p, n) {
    const [eng, format, name] = s(p, n).split("\t");
    let key = null;
    const rp = name ? resolvePath(name, format, eng) : null;
    if (name && !name.includes("/") && bundledNames.has(name) && !(rp && /^tex\/(xe|lua)(la)?tex\//.test(rp))) key = name;
    else key = rp;
    if (!key) { if (name) unresolved.push(name); return 0; }
    fetched = Buffer.from(enc.encode(key));
    return fetched.length;
  },
  fetch(p, n) {
    const [eng, name] = s(p, n).split("\t");
    const parts = [];
    if (!name.includes("/") && bundledNames.has(name)) {
      const one = framed([Buffer.from(enc.encode(name)), fs.readFileSync(path.join(extDir, "texmf", name))]);
      one.writeUInt32LE(1, 0);
      parts.push(one);
    } else {
      const r = rows.get(name);
      const k = (meta.deps ?? []).indexOf(eng);
      for (const id of r ? [r.pack, ...(k >= 0 ? r.deps[k] ?? [] : [])] : []) {
        asked.push(id);
        const f = path.join(bundledPacks.has(id) && fs.existsSync(path.join(extDir, "packs", id + ".pack")) ? path.join(extDir, "packs") : packsDir, id + ".pack");
        if (fs.existsSync(f)) parts.push(fs.readFileSync(f));
      }
    }
    if (!parts.length) return 0;
    fetched = framed(parts);
    return fetched.length;
  },
  fetch_copy(dst) { new Uint8Array(mem.buffer, dst >>> 0, fetched.length).set(fetched); fetched = undefined; },
  system_run() { return 0; },
  system_copy() {},
};
const wasi = {
  clock_time_get(id, _p, out) { new DataView(mem.buffer).setBigUint64(out >>> 0, BigInt(Math.round((id === 0 ? performance.timeOrigin + performance.now() : performance.now()) * 1e6)), true); return 0; },
  environ_sizes_get(c, sz) { const d = new DataView(mem.buffer); d.setUint32(c >>> 0, 0, true); d.setUint32(sz >>> 0, 0, true); return 0; },
  environ_get: () => 0,
  fd_write(fd, iovs, n, written) {
    const d = new DataView(mem.buffer); let t = 0;
    for (let i = 0; i < n; i++) t += d.getUint32((iovs >>> 0) + 8 * i + 4, true);
    d.setUint32(written >>> 0, t, true); return fd === 1 || fd === 2 ? 0 : ENOSYS;
  },
  fd_prestat_get: () => EBADF, fd_prestat_dir_name: () => EBADF, path_open: () => EBADF, fd_read: () => EBADF,
  fd_close: () => EBADF, fd_fdstat_get: () => EBADF, fd_filestat_get: () => EBADF, fd_seek: () => EBADF,
  random_get(p, n) { crypto.getRandomValues(new Uint8Array(mem.buffer, p >>> 0, n)); return 0; },
  sched_yield: () => 0,
  proc_exit(c) { throw new Error(`exit ${c}`); },
};
// (anything else the core imports: a stub)
const imports = { wasi_snapshot_preview1: wasi, phitex };
for (const i of WebAssembly.Module.imports(mod)) {
  imports[i.module] ??= {};
  if (i.kind === "function" && !(i.name in imports[i.module])) imports[i.module][i.name] = () => 0;
}
const x = new WebAssembly.Instance(mod, imports).exports;
mem = x.memory;
x._initialize?.();
const call = (buf, g) => { const p = x.ph_alloc(buf.length); new Uint8Array(mem.buffer, p >>> 0, buf.length).set(buf); try { return g(p, buf.length); } finally { x.ph_free(p, buf.length); } };
const out = () => dec.decode(new Uint8Array(mem.buffer, x.ph_out_ptr() >>> 0, x.ph_out_len() >>> 0));
call(gunzipSync(fs.readFileSync(path.join(extDir, "dist/assets.bin.gzdata"))), (p, n) => x.ph_assets(p, n));
if (engine === "xelatex") call(gunzipSync(fs.readFileSync(path.join(extDir, "dist/assets-xelatex.bin.gzdata"))), (p, n) => x.ph_assets(p, n));

const main = mainArg && files[mainArg] !== undefined ? mainArg : Object.keys(files).find((f) => /\\documentclass/.test(files[f]) && /\\begin\{document\}/.test(files[f]));
let res = { ok: false };
try {
  if (!main) throw new Error("no main file");
  const parts = [u32(FUEL), ...str(main), u32(Object.keys(files).length)];
  for (const [n, t] of Object.entries(files)) parts.push(...str(n), ...str(t));
  parts.push(u32(0), u32(engine === "xelatex" ? 1 : 0), u32(1));
  const h = call(Buffer.concat(parts), (p, n) => x.ph_open(p, n));
  const j = JSON.parse(out() || "{}");
  res = { ok: !!h, pages: Array.isArray(j.pages) ? j.pages.length : j.pages, error: j.error ? (typeof j.error === "string" ? j.error : j.error.message)?.slice(0, 200) : undefined, missing: j.missing?.length };
} catch (e) {
  res = { ok: false, error: String(e).slice(0, 200) };
}
console.log(JSON.stringify({ ...res, main, engine, ms: Math.round(performance.now() - t0), packs: [...new Set(asked)], unresolved: [...new Set(unresolved)].slice(0, 50) }));
