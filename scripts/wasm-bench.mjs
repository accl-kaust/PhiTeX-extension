// Headless benchmark of the wasm core, driven as the worker drives it (no
// browser): assets, open, the first page, then edits typed one key at a time
// into a paragraph, each drawing the page it is on. Prints JSON:
// { open_ms, first_ms, edits: [ms…], median, p90 }.
//   node scripts/wasm-bench.mjs CORE.wasm DIST_DIR MAIN.tex [--edits N] [--at TEXT] [--packs DIR]
// DIST_DIR: the built extension (extension/dist/..: assets.bin.gzdata, texmf/,
// packs/, shelf-index.tsv.gz). Shelf packs not bundled are read from --packs
// DIR (default target/bench-packs); with --net, a missing one is fetched from
// Shelf into it, so a run elsewhere needs no network once that has run here.
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const [wasmPath, dist, mainPath] = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--edits") && !["--at", "--packs"].includes(argv[i - 1]));
const N = +opt("--edits", 30), AT = opt("--at", "Section 4}"), PACKS = opt("--packs", "target/bench-packs"), NET = argv.includes("--net");
const ext = path.resolve(dist, "..");
fs.mkdirSync(PACKS, { recursive: true });

const index = new Map();
for (const l of gunzipSync(fs.readFileSync(path.join(ext, "shelf-index.tsv.gz"))).toString().split("\n")) {
  const [name, pack, deps] = l.split("\t");
  if (name && pack) index.set(name, [pack, ...(deps ? deps.split(",") : [])]);
}
const texmf = new Set(fs.readFileSync(path.join(ext, "texmf/names.txt"), "utf8").split("\n").filter(Boolean));
const enc = new TextEncoder(), dec = new TextDecoder();
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const framed = (parts) => Buffer.concat([u32(parts.length), ...parts.flatMap((p) => [u32(p.length), p])]);
function pack(id) {
  const own = path.join(ext, "packs", id + ".pack"), got = path.join(PACKS, id + ".pack");
  if (fs.existsSync(own)) return fs.readFileSync(own);
  if (!fs.existsSync(got)) {
    if (!NET) return null;
    try { execFileSync("curl", ["-sfo", got, `https://shelf-phitex.pages.dev/tl2026/p/${encodeURIComponent(id)}.pack`]); } catch { return null; }
  }
  return fs.readFileSync(got);
}

let mem, fetched;
const phitex = {
  fetch(ptr, len) {
    const name = dec.decode(new Uint8Array(mem.buffer, ptr >>> 0, len >>> 0));
    const parts = [];
    if (texmf.has(name)) {
      const one = framed([enc.encode(name), fs.readFileSync(path.join(ext, "texmf", name))]);
      one.writeUInt32LE(1, 0);
      parts.push(one);
    } else for (const id of index.get(name) ?? []) { const b = pack(id); if (b?.[0] === 0x1f) parts.push(b); }
    if (!parts.length) return 0;
    fetched = framed(parts);
    return fetched.length;
  },
  fetch_copy(dst) { new Uint8Array(mem.buffer, dst >>> 0, fetched.length).set(fetched); fetched = undefined; },
};
const EBADF = 8;
const wasi = {
  clock_time_get(id, _p, out) { new DataView(mem.buffer).setBigUint64(out >>> 0, BigInt(Math.round((id === 0 ? performance.timeOrigin : 0) * 1e6 + performance.now() * 1e6)), true); return 0; },
  environ_sizes_get(c, s) { const d = new DataView(mem.buffer); d.setUint32(c, 0, true); d.setUint32(s, 0, true); return 0; },
  environ_get: () => 0,
  fd_write(fd, iovs, n, written) {
    const d = new DataView(mem.buffer); let t = 0;
    for (let i = 0; i < n; i++) t += d.getUint32(iovs + 8 * i + 4, true);
    d.setUint32(written, t, true); return 0;
  },
  fd_prestat_get: () => EBADF, fd_prestat_dir_name: () => EBADF, path_open: () => EBADF, fd_read: () => EBADF,
  fd_close: () => EBADF, fd_fdstat_get: () => EBADF, fd_filestat_get: () => EBADF,
  random_get(p, n) { crypto.getRandomValues(new Uint8Array(mem.buffer, p, n)); return 0; },
  proc_exit(c) { throw new Error(`exit ${c}`); },
};

const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), { wasi_snapshot_preview1: wasi, phitex });
const x = instance.exports;
mem = x.memory;
x._initialize?.();
const call = (buf, g) => { const p = x.ph_alloc(buf.length); new Uint8Array(mem.buffer, p >>> 0, buf.length).set(buf); try { return g(p, buf.length); } finally { x.ph_free(p, buf.length); } };
const str = (s) => { const b = enc.encode(s); return [u32(b.length), b]; };
const out = () => dec.decode(new Uint8Array(mem.buffer, x.ph_out_ptr() >>> 0, x.ph_out_len() >>> 0));
call(gunzipSync(fs.readFileSync(path.join(dist, "assets.bin.gzdata"))), (p, n) => x.ph_assets(p, n));

const main = fs.readFileSync(mainPath, "utf8"), name = path.basename(mainPath);
let t = performance.now();
const h = call(Buffer.concat([u32(1e9), ...str(name), u32(1), ...str(name), ...str(main), u32(0)]), (p, n) => x.ph_open(p, n));
if (!h) throw new Error("open: " + out());
const open_ms = performance.now() - t;
const st = () => (x.ph_status(h), JSON.parse(out()));
// (the first page: what open built; then the session's idle work, as the worker's idle loop)
t = performance.now();
while (x.ph_idle?.()) {}
const first_ms = performance.now() - t;
const pages = st().pages;

// typing: one key at a time, after AT's paragraph start
let at = enc.encode(main.slice(0, main.indexOf(AT) + AT.length + 1)).length;
const page = Math.min(3, pages - 1), edits = [];
for (let i = 0; i < N; i++) {
  const c = "abcdefghij"[i % 10];
  t = performance.now();
  const ok = call(Buffer.concat([...str(name), u32(at), u32(at), ...str(c)]), (p, n) => x.ph_edit(h, p, n, page, 96));
  if (ok) x.ph_png_last();
  edits.push(+(performance.now() - t).toFixed(2));
  if (ok !== 1) throw new Error("edit: " + out().slice(0, 300));
  at += 1;
}
const s = [...edits].sort((a, b) => a - b);
console.log(JSON.stringify({ wasm: path.basename(wasmPath), pages, open_ms: +open_ms.toFixed(1), first_ms: +first_ms.toFixed(1), median: s[s.length >> 1], p90: s[Math.floor(s.length * 0.9)], edits }));
