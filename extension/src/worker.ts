import { indexBytes, packUrl } from "./release.ts";
// The PhiTeX core in a dedicated worker: the wasm (wasm32-wasip1) on a
// minimal WASI shim, one session per client (an Overleaf tab).
//
// Threads, later: a wasm32-wasip1-threads build imports its memory (shared)
// and `wasi.thread-spawn`; this worker would then create the
// WebAssembly.Memory({shared: true}) and spawn sub-workers given (module,
// memory). That needs SharedArrayBuffer, i.e. a cross-origin isolated
// context: why this worker is started from the offscreen document (an
// extension page, isolated by the manifest's COOP/COEP) and never from the
// Overleaf page.

export type Req =
  | { id: number; client: string; op: "open"; main: string; files: Record<string, string>; fuel: number; binaries?: Record<string, Uint8Array>; engine?: string }
  | { id: number; client: string; op: "edit"; file: string; start: number; end: number; text: string; page: number; dpi: number }
  | { id: number; client: string; op: "set_file"; file: string; text: string }
  | { id: number; client: string; op: "set_bytes"; file: string; bytes: Uint8Array }
  | { id: number; client: string; op: "png"; page: number; dpi: number }
  | { id: number; client: string; op: "pdf" }
  | { id: number; client: string; op: "status" }
  | { id: number; client: string; op: "log" }
  | { id: number; client: string; op: "pages" }
  | { id: number; client: string; op: "origins"; page: number }
  | { id: number; client: string; op: "trace"; on: boolean }
  | { id: number; client: string; op: "auxdump" }
  | { id: number; client: string; op: "check"; file?: string; expect?: string }
  | { id: number; client: string; op: "close" }
  /** (the draw worker: the PDF the core just linked, to draw pages from) */
  | { id: number; client: string; op: "drawpdf"; pdf: Uint8Array };

export interface Res {
  id: number;
  ok: boolean;
  json?: any;
  png?: Uint8Array;
  /** A page as its draw list (asked for with dpi 0): see session.ts's Draws. */
  draws?: unknown;
  pdf?: Uint8Array;
  /** PDF mode: the page to render from the PDF (`pdf`, or the last one sent with this key). */
  render?: { page: number; dpi: number; key: string };
  error?: string;
}

interface Core {
  memory: WebAssembly.Memory;
  /** The partex core: the LaTeX format and fonts (assets.bin.gzdata: gzip, gunzipped). */
  ph_assets?(p: number, n: number): number;
  ph_alloc(n: number): number;
  ph_free(p: number, n: number): void;
  ph_out_ptr(): number;
  ph_out_len(): number;
  ph_open(p: number, n: number): number;
  /** The worker has a \\write18 runner (minted). */
  ph_set_system?(on: number): void;
  ph_close(h: number): void;
  ph_edit(h: number, p: number, n: number, page: number, dpi: number): number;
  ph_png_last(): void;
  ph_set_file(h: number, p: number, n: number): number;
  /** The partex core: a binary file (`str name`, then the bytes). */
  ph_set_bytes?(h: number, p: number, n: number): number;
  ph_png(h: number, page: number, dpi: number): void;
  ph_pdf(h: number): void;
  ph_check(h: number): void;
  ph_status(h: number): void;
  ph_log?(h: number): void;
  ph_idle?(): number;
  ph_pages(h: number): void;
  ph_origins?(h: number, page: number): void;
  ph_trace?(h: number, on: number): void;
  ph_auxdump?(h: number): void;
  ph_panic_ptr?(): number;
  ph_panic_len?(): number;
  ph_draw_set?(slot: number, p: number, n: number): number;
  ph_draw_page?(slot: number, k: number): number;
  ph_draw_hash?(slot: number, k: number): void;
  ph_draw_drop?(slot: number): void;
  ph_text(h: number, p: number, n: number): void;
  _initialize?(): void;
}

class Exit extends Error {}

/**
 * Shelf, for the core (its `phitex.fetch` import, shelf.rs): a file TeX asks
 * for and the session lacks, fetched there and then (a synchronous request,
 * as a worker may make), so the job never stops at a file TeX Live has.
 * The name's pack and the packs its loading reads, by the index the
 * extension ships; the browser's cache keeps them (Shelf's packs are
 * immutable). The extension's bundled texmf/ files go as a pack of one.
 */
let shelfIndex: Map<string, string[]> | undefined;
let bundledNames: Set<string> | undefined;
/** Shelf packs the extension ships (packs/: the ones most documents load), read from it, not Shelf. */
let bundledPacks = new Set<string>();
let fetched: Uint8Array | undefined;

async function loadShelf(): Promise<void> {
  if (shelfIndex) return;
  // (Shelf's newest release this extension has, else its own copy: release.ts)
  const { gz } = await indexBytes(() => fetch(new URL("../shelf-index.tsv.gzdata", import.meta.url)));
  const tsv = await new Response(gz.pipeThrough(new DecompressionStream("gzip"))).text();
  const m = new Map<string, string[]>();
  for (const l of tsv.split("\n")) {
    const [name, pack, deps] = l.split("\t");
    if (name && pack) m.set(name, [pack, ...(deps ? deps.split(",") : [])]);
  }
  const names = await (await fetch(new URL("../texmf/names.txt", import.meta.url))).text();
  bundledNames = new Set(names.split("\n").filter(Boolean));
  const packs = await fetch(new URL("../packs/list.txt", import.meta.url)).then((r) => (r.ok ? r.text() : ""), () => "");
  bundledPacks = new Set(packs.split("\n").filter(Boolean));
  shelfIndex = m;
}

function getSync(url: string): Uint8Array | null {
  const x = new XMLHttpRequest();
  x.open("GET", url, false);
  x.responseType = "arraybuffer";
  try {
    x.send();
  } catch {
    return null;
  }
  return x.status === 200 ? new Uint8Array(x.response as ArrayBuffer) : null;
}

/** `u32 n, (u32 len, bytes) × n`, little-endian. */
function framed(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(4 + parts.reduce((a, p) => a + 4 + p.length, 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, parts.length, true);
  let at = 4;
  for (const p of parts) {
    dv.setUint32(at, p.length, true);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

/**
 * `\write18` (core-partex system.rs): latexminted with Pygments in Pyodide,
 * the engine's tools/minted-pyodide runner, loaded (and bundled: no code
 * from the network) only for a project that uses minted; the core runs
 * commands only once it is (`ph_set_system`).
 */
type Runner = { system(command: string, files: [string, Uint8Array][]): { status: number; wrote: Map<string, Uint8Array>; removed: string[] } };
let minted: Runner | undefined;
/** What minted cost (status): Pyodide's load, then each command (the last 20). */
const mintedStats: { load_ms?: number; calls: { cmd: string; files: number; bytes: number; ms: number; wrote: number }[] } = { calls: [] };
let mintedLoading: Promise<void> | undefined;

/** Whether a project's sources load minted. */
export function usesMinted(files: Record<string, string>): boolean {
  return Object.values(files).some((t) => /\\(usepackage|RequirePackage)\s*(\[[^\]]*\])?\s*\{[^}]*\bminted\b/.test(t));
}

function loadMinted(): Promise<void> {
  mintedLoading ??= (async () => {
    const t0 = performance.now();
    const at = (p: string) => new URL(p, import.meta.url).href;
    const { loadPyodide } = await import(/* @vite-ignore */ at("pyodide/pyodide.mjs"));
    const { createMintedRunner } = await import(/* @vite-ignore */ at("minted/runner.mjs"));
    const names = (await (await fetch(at("../minted/wheels.txt"))).text()).split("\n").filter(Boolean);
    const wheels = await Promise.all(names.map(async (n) => [n, new Uint8Array(await (await fetch(at("../minted/" + n + ".data"))).arrayBuffer())]));
    // (stdlib and wheels named .data: Edge's store refuses archives in a package)
    minted = await createMintedRunner({ loadPyodide, pyodideOptions: { indexURL: at("pyodide/"), stdLibURL: at("pyodide/python_stdlib.data") }, wheels });
    core.ph_set_system?.(1);
    mintedStats.load_ms = Math.round(performance.now() - t0);
  })();
  return mintedLoading;
}

function systemImports(mem: () => WebAssembly.Memory) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let pending = new Uint8Array(0);
  const bytes = (p: number, n: number) => new Uint8Array(mem().buffer, p >>> 0, n >>> 0);
  const unframe = (b: Uint8Array): [string, Uint8Array][] => {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let at = 0;
    const out: [string, Uint8Array][] = [];
    for (let n = v.getUint32(0, true), i = (at = 4, 0); i < n; i++) {
      const k = v.getUint32(at, true);
      const name = dec.decode(b.subarray(at + 4, at + 4 + k));
      at += 4 + k;
      const l = v.getUint32(at, true);
      out.push([name, b.slice(at + 4, at + 4 + l)]);
      at += 4 + l;
    }
    return out;
  };
  // (u32 n, (u32 len, name, u32 len, bytes) × n: n files, not parts)
  const frame = (files: [string, Uint8Array][]) => {
    const f = framed(files.flatMap(([n, b]) => [enc.encode(n), b]));
    new DataView(f.buffer).setUint32(0, files.length, true);
    return f;
  };
  return {
    system_run(cmdPtr: number, cmdLen: number, filesPtr: number, filesLen: number): number {
      const command = dec.decode(bytes(cmdPtr, cmdLen).slice());
      let status = 127 << 8, wrote: [string, Uint8Array][] = [], removed: string[] = [];
      if (minted) {
        const t0 = performance.now();
        const files = unframe(bytes(filesPtr, filesLen).slice());
        const r = minted.system(command, files);
        (status = r.status), (wrote = [...r.wrote]), (removed = r.removed);
        mintedStats.calls.push({ cmd: command.slice(0, 60), files: files.length, bytes: filesLen, ms: Math.round(performance.now() - t0), wrote: wrote.length });
        if (mintedStats.calls.length > 20) mintedStats.calls.shift();
      }
      const a = frame(wrote), b = frame(removed.map((n) => [n, new Uint8Array(0)]));
      pending = new Uint8Array(4 + a.length + b.length);
      new DataView(pending.buffer).setInt32(0, status, true);
      pending.set(a, 4);
      pending.set(b, 4 + a.length);
      return pending.length;
    },
    system_copy(dst: number): void {
      bytes(dst, pending.length).set(pending);
      pending = new Uint8Array(0);
    },
  };
}

function shelfImports(mem: () => WebAssembly.Memory) {
  return {
    fetch(ptr: number, len: number): number {
      const name = new TextDecoder().decode(new Uint8Array(mem().buffer, ptr >>> 0, len >>> 0));
      const parts: Uint8Array[] = [];
      if (bundledNames?.has(name)) {
        const b = getSync(new URL("../texmf/" + name, import.meta.url).href);
        if (b) {
          // (a pack of one file: its count 1, then the name and the bytes, each with its length)
          const one = framed([enc.encode(name), b]);
          new DataView(one.buffer).setUint32(0, 1, true);
          parts.push(one);
        }
      } else {
        for (const id of shelfIndex?.get(name) ?? []) {
          const here = bundledPacks.has(id);
          if (!here) (self as unknown as Worker).postMessage({ fetching: id, name });
          const b = getSync(here ? new URL(`../packs/${id}.pack`, import.meta.url).href : packUrl(id));
          if (b && b[0] === 0x1f && b[1] === 0x8b) parts.push(b);
        }
      }
      if (!parts.length) return 0;
      fetched = framed(parts);
      return fetched.length;
    },
    fetch_copy(dst: number): void {
      new Uint8Array(mem().buffer, dst >>> 0, fetched!.length).set(fetched!);
      fetched = undefined;
    },
  };
}

/** Just what the core imports (see the build's import section). */
function wasi(mem: () => WebAssembly.Memory) {
  const ENOSYS = 52, EBADF = 8;
  const dv = () => new DataView(mem().buffer);
  const origin = performance.timeOrigin;
  return {
    clock_time_get(id: number, _precision: bigint, out: number): number {
      // 0 realtime, 1 monotonic: both from performance.now (µs resolution)
      const ms = id === 0 ? origin + performance.now() : performance.now();
      dv().setBigUint64(out >>> 0, BigInt(Math.round(ms * 1e6)), true);
      return 0;
    },
    environ_sizes_get(count: number, size: number): number {
      dv().setUint32(count >>> 0, 0, true);
      dv().setUint32(size >>> 0, 0, true);
      return 0;
    },
    environ_get(): number {
      return 0;
    },
    fd_write(fd: number, iovs: number, n: number, written: number): number {
      const d = dv();
      let total = 0;
      let s = "";
      for (let i = 0; i < n; i++) {
        const p = d.getUint32((iovs >>> 0) + 8 * i, true);
        const l = d.getUint32((iovs >>> 0) + 8 * i + 4, true);
        s += new TextDecoder().decode(new Uint8Array(mem().buffer, p, l));
        total += l;
      }
      if (fd === 1 || fd === 2) console[fd === 2 ? "warn" : "log"]("[phitex]", s);
      d.setUint32(written >>> 0, total, true);
      return fd === 1 || fd === 2 ? 0 : ENOSYS;
    },
    // (no files and no preopened directories: std::fs, which PhiTeX calls
    // for a font the core does not carry, finds nothing)
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    path_open: () => EBADF,
    fd_read: () => EBADF,
    fd_close: () => EBADF,
    fd_fdstat_get: () => EBADF,
    fd_filestat_get: () => EBADF,
    random_get(p: number, n: number): number {
      for (let at = 0; at < n; at += 65536) crypto.getRandomValues(new Uint8Array(mem().buffer, p + at, Math.min(65536, n - at)));
      return 0;
    },
    proc_exit(code: number): never {
      throw new Exit(`wasm exited (${code})`);
    },
  };
}

const enc = new TextEncoder();

/** Frames `u32`s and `str`s as the core reads them. */
class Frame {
  parts: Uint8Array[] = [];
  len = 0;
  u32(x: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, x, true);
    this.parts.push(b);
    this.len += 4;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.u32(b.length);
    this.parts.push(b);
    this.len += b.length;
    return this;
  }
  str(s: string): this {
    const b = enc.encode(s);
    this.u32(b.length);
    this.parts.push(b);
    this.len += b.length;
    return this;
  }
}

let core: Core;
let module: WebAssembly.Module;
let assets: Promise<Uint8Array> | undefined;

/** The partex core's assets (the format, the fonts' metrics), fetched and gunzipped once. */
const loadAssets = () =>
  (assets ??= fetch(new URL("assets.bin.gzdata", import.meta.url)).then(async (r) => {
    if (!r.ok) throw new Error(`assets: ${r.status}`);
    return new Uint8Array(await new Response(r.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  }));

let xeAssets: Promise<Uint8Array> | undefined;
/** The core instance XeTeX's assets were given to (a new instance after a trap needs them again). */
let xeCore: Core | undefined;

/**
 * XeTeX's assets (assets-xelatex.bin.gzdata: its format, the font index,
 * dvipdfmx.cfg, the TECkit mappings), fetched and given to the core once,
 * for the first xelatex project: a pdfLaTeX-only user never loads them.
 */
async function loadXe(): Promise<void> {
  if (xeCore === core || !core.ph_assets) return;
  const a = await (xeAssets ??= fetch(new URL("assets-xelatex.bin.gzdata", import.meta.url)).then(async (r) => {
    if (!r.ok) throw new Error(`xelatex assets: ${r.status}`);
    return new Uint8Array(await new Response(r.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  }));
  const p = core.ph_alloc(a.length);
  new Uint8Array(core.memory.buffer, p >>> 0, a.length).set(a);
  const n = core.ph_assets(p, a.length);
  core.ph_free(p, a.length);
  if (!n) throw new Error("xelatex assets: bad framing");
  xeCore = core;
}

/** The clients whose project is XeTeX's: their pages are drawn here (with the glyph runs), not by the draw worker. */
const xetexClients = new Set<string>();

/**
 * The draw worker (a second instance of the core, named "draw"): it only
 * draws pages from the PDF the build worker links, so pages draw while a
 * build, or readying the next one, runs there.
 */
const DRAW = (self as unknown as { name?: string }).name === "draw";

async function load(): Promise<void> {
  module ??= await WebAssembly.compileStreaming(fetch(new URL("core.wasm", import.meta.url)));
  let memory: WebAssembly.Memory | undefined;
  if (!DRAW) await loadShelf().catch(() => undefined);
  const inst = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi(() => memory!),
    phitex: { ...shelfImports(() => memory!), ...systemImports(() => memory!) },
  });
  core = inst.exports as unknown as Core;
  memory = core.memory;
  core._initialize?.();
  if (core.ph_assets && !DRAW) {
    const a = await loadAssets();
    const p = core.ph_alloc(a.length);
    new Uint8Array(core.memory.buffer, p >>> 0, a.length).set(a);
    const n = core.ph_assets(p, a.length);
    core.ph_free(p, a.length);
    if (!n) throw new Error("assets: bad framing");
  }
}

function call<T>(f: Frame, g: (p: number, n: number) => T): T {
  const p = core.ph_alloc(f.len);
  // (pointers past 2 GB come back negative as i32: unsigned)
  const m = new Uint8Array(core.memory.buffer, p >>> 0, f.len);
  let at = 0;
  for (const part of f.parts) {
    m.set(part, at);
    at += part.length;
  }
  try {
    return g(p, f.len);
  } finally {
    core.ph_free(p, f.len);
  }
}

/**
 * PDF mode (the partex core): page `page` to be rendered from the PDF, by
 * the offscreen document (pdf.js). The PDF goes along only when it changed
 * since the last one this worker sent (its length and hash say so).
 */
let lastPdf = "";
function pdfPage(h: number, page: number, dpi: number): Partial<Res> {
  core.ph_pdf(h);
  const pdf = outBytes();
  if (!pdf.length) return {};
  // (FNV-1a over every byte: ~2 ms a MB; a sample would miss a one-letter edit)
  let x = 0x811c9dc5;
  for (let i = 0; i < pdf.length; i++) x = Math.imul(x ^ pdf[i], 0x01000193);
  const key = `${h}:${pdf.length}:${x}`;
  const same = key === lastPdf;
  lastPdf = key;
  return { render: { page, dpi, key }, pdf: same ? undefined : pdf };
}

function outBytes(): Uint8Array {
  return new Uint8Array(core.memory.buffer, core.ph_out_ptr() >>> 0, core.ph_out_len() >>> 0).slice();
}
const outJson = () => JSON.parse(new TextDecoder().decode(outBytes()));

/** Client → session handle; and what opened it, to reopen after a trap. */
const sessions = new Map<string, number>();

function handle(r: Req): Res {
  const h = sessions.get(r.client) ?? 0;
  switch (r.op) {
    case "open": {
      // (one core: pdfLaTeX's or XeTeX's; LuaTeX's not yet)
      if (r.engine && r.engine !== "pdflatex" && r.engine !== "xelatex") return { id: r.id, ok: false, error: `${r.engine} is not available in this version` };
      if (r.engine === "xelatex") xetexClients.add(r.client);
      else xetexClients.delete(r.client);
      if (h) core.ph_close(h);
      const f = new Frame().u32(r.fuel).str(r.main).u32(Object.keys(r.files).length);
      for (const [n, t] of Object.entries(r.files)) f.str(n).str(t);
      // (the project's binary files, figures: in the open, so the first build has them)
      const bins = Object.entries(r.binaries ?? {});
      f.u32(bins.length);
      for (const [n, b] of bins) f.str(n).bytes(b);
      // (the engine: 1 XeTeX)
      f.u32(r.engine === "xelatex" ? 1 : 0);
      const nh = call(f, (p, n) => core.ph_open(p, n));
      const json = outJson();
      // (the pages' hashes with it: the tab lays them out now, not after
      // a request that would wait behind readying the first rebuild)
      if (nh && json) {
        core.ph_pages(nh);
        json.hashes = outJson().pages;
      }
      if (nh) sessions.set(r.client, nh);
      return { id: r.id, ok: nh !== 0, json };
    }
    case "edit": {
      const f = new Frame().str(r.file).u32(r.start).u32(r.end).str(r.text);
      const ok = call(f, (p, n) => core.ph_edit(h, p, n, r.page < 0 ? 0xffffffff : r.page, r.dpi));
      const json = outJson();
      let png: Uint8Array | undefined;
      if (ok && r.page >= 0) {
        core.ph_png_last();
        png = outBytes();
        // (PDF mode: no draw list; the PDF, for the offscreen document's renderer)
        if (!png.length && core.ph_assets) return { id: r.id, ok: ok === 1, json, ...pdfPage(h, Math.min(r.page, Math.max((json.pages ?? 1) - 1, 0)), r.dpi) };
      }
      return { id: r.id, ok: ok === 1, json, png };
    }
    case "set_file": {
      const ok = call(new Frame().str(r.file).str(r.text), (p, n) => core.ph_set_file(h, p, n));
      return { id: r.id, ok: ok === 1, json: ok ? outJson() : undefined };
    }
    case "set_bytes": {
      if (!core.ph_set_bytes) return { id: r.id, ok: false, error: "this core takes no binary files" };
      const f = new Frame().str(r.file);
      f.parts.push(r.bytes);
      f.len += r.bytes.length;
      const ok = call(f, (p, n) => core.ph_set_bytes!(h, p, n));
      return { id: r.id, ok: ok === 1 };
    }
    case "png": {
      core.ph_png(h, r.page, r.dpi);
      const png = outBytes();
      if (!png.length && core.ph_assets) return { id: r.id, ok: true, ...pdfPage(h, r.page, r.dpi) };
      return { id: r.id, ok: true, png };
    }
    case "status": {
      core.ph_status(h);
      const json = outJson();
      if (mintedStats.load_ms !== undefined) json.minted = mintedStats;
      return { id: r.id, ok: true, json };
    }
    case "log":
      // (debugging: the whole terminal and the job's .log)
      if (!core.ph_log) return { id: r.id, ok: false, error: "this core keeps no log" };
      core.ph_log(h);
      return { id: r.id, ok: true, json: { log: new TextDecoder().decode(outBytes()) } };
    case "auxdump":
      // (debugging: the auxiliary files carried in, held, and written)
      if (!core.ph_auxdump) return { id: r.id, ok: false, error: "no auxdump" };
      core.ph_auxdump(h);
      return { id: r.id, ok: true, json: outJson() };
    case "trace":
      // (debugging: each rebuild's trace kept in the build log, `log`)
      core.ph_trace?.(h, r.on ? 1 : 0);
      return { id: r.id, ok: !!core.ph_trace };
    case "drawpdf":
      return { id: r.id, ok: false, error: "drawpdf is the draw worker's" };
    case "origins":
      // (each glyph of page `page`, in stream order, with its source bytes)
      if (!core.ph_origins) return { id: r.id, ok: false, error: "this core keeps no origins" };
      core.ph_origins(h, r.page);
      return { id: r.id, ok: true, json: outJson() };
    case "pages":
      core.ph_pages(h);
      return { id: r.id, ok: true, json: outJson() };
    case "pdf":
      core.ph_pdf(h);
      return { id: r.id, ok: true, pdf: outBytes() };
    case "check": {
      core.ph_check(h);
      const json = outJson();
      if (r.file !== undefined && r.expect !== undefined) {
        call(new Frame().str(r.file), (p, n) => core.ph_text(h, p, n));
        const have = new TextDecoder().decode(outBytes());
        json.text_ok = have === r.expect;
        if (!json.text_ok) {
          json.ok = false;
          json.mismatch = (json.mismatch ? json.mismatch + "; " : "") + `core's ${r.file} differs from the editor's text`;
        }
      }
      return { id: r.id, ok: true, json };
    }
    case "close":
      if (h) core.ph_close(h);
      sessions.delete(r.client);
      return { id: r.id, ok: true };
  }
}

const ready = load();

/**
 * PhiTeX's PNGs are stored, not deflated (~0.9 MB a page at 96 dpi), and a
 * chrome port carries them as base64 JSON: recompressed here with the
 * browser's own encoder (lossless) they are ~20x smaller. (REPORT.md: a
 * deflated PNG, or raw pixels, from phitex-layout would make this moot.)
 */
async function compress(png: Uint8Array): Promise<Uint8Array> {
  if (typeof OffscreenCanvas === "undefined" || png.length < 32 * 1024) return png;
  const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
}

/** The page hashes each client's drawer was last given a PDF for. */
const shipped = new Map<string, string>();

/** After a build: the PDF to the draw worker (through the offscreen document) if its pages changed. */
function shipPdf(r: Req): void {
  if (!core.ph_draw_set || !(r.op === "open" || r.op === "status" || (r.op === "edit" && r.page >= 0))) return;
  shipFor(r.client);
}

/** Client `client`'s PDF to the drawer, if its pages changed since the last one sent. */
function shipFor(client: string): void {
  const h = sessions.get(client);
  if (!h || !core.ph_draw_set || xetexClients.has(client)) return;
  core.ph_pages(h);
  const key = new TextDecoder().decode(outBytes());
  if (shipped.get(client) === key) return;
  shipped.set(client, key);
  core.ph_pdf(h);
  const pdf = outBytes();
  if (pdf.length) (self as unknown as Worker).postMessage({ drawPdf: true, client, pdf }, [pdf.buffer]);
}

// ---- the draw worker ----

const slots = new Map<string, number>();
/** Per client: the page last asked for (drawn around first) and the PDF's version. */
const around = new Map<string, number>();
const version = new Map<string, number>();
let nextSlot = 1;

function drawPage(slot: number, k: number): { draws?: unknown; hash: string; fresh: boolean } {
  const got = core.ph_draw_page!(slot, k);
  const json = got ? new TextDecoder().decode(outBytes()) : "";
  core.ph_draw_hash!(slot, k);
  return { draws: json ? JSON.parse(json) : undefined, hash: new TextDecoder().decode(outBytes()), fresh: got === 1 };
}

/** Every page drawn ahead, nearest the one read first, a page a task (so asks come between). */
function drawAhead(client: string, n: number): void {
  const v = version.get(client);
  let at = 0;
  const next = (): void => {
    if (version.get(client) !== v || !slots.has(client)) return;
    const p = around.get(client) ?? 0;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => Math.abs(a - p) - Math.abs(b - p));
    if (at >= order.length) return;
    try {
      drawPage(slots.get(client)!, order[at++]);
    } catch {
      return;
    }
    setTimeout(next, 0);
  };
  setTimeout(next, 0);
}

function handleDraw(r: Req): Res {
  let slot = slots.get(r.client);
  if (r.op === "close") {
    if (slot) core.ph_draw_drop!(slot);
    slots.delete(r.client);
    return { id: r.id, ok: true };
  }
  if (!slot) slots.set(r.client, (slot = nextSlot++));
  if (r.op === "drawpdf") {
    const n = call(new Frame().bytes(r.pdf), (p, len) => core.ph_draw_set!(slot!, p + 4, len - 4));
    version.set(r.client, (version.get(r.client) ?? 0) + 1);
    drawAhead(r.client, n);
    return { id: r.id, ok: true, json: { pages: n } };
  }
  if (r.op === "png") {
    around.set(r.client, r.page);
    const t = performance.now();
    const d = drawPage(slot, r.page);
    return { id: r.id, ok: !!d.draws, draws: d.draws as Res["draws"], json: { hash: d.hash, draw_ms: performance.now() - t, kept: !d.fresh } };
  }
  return { id: r.id, ok: false, error: `the draw worker does not do ${r.op}` };
}

/** The panic the core kept before its trap (`: message`), or "". */
function panicText(): string {
  // (the memory it had: a trap with no panic is often an allocation that failed, wasm32's 4 GB)
  let mem = "";
  try {
    mem = ` (memory ${Math.round(core.memory.buffer.byteLength / 1048576)} MB)`;
  } catch {
    /* (no memory to read) */
  }
  try {
    const n = core.ph_panic_len?.() ?? 0;
    return (n ? `: ${new TextDecoder().decode(new Uint8Array(core.memory.buffer, core.ph_panic_ptr!() >>> 0, n))}` : ": no panic message") + mem;
  } catch {
    return mem;
  }
}

/**
 * A trap in the idle work (readying a rebuild), which no request waits on:
 * the instance is unusable from there (a RefCell it held stays borrowed), so
 * the next request gets this trap, and a new instance, not a second panic.
 */
let idleTrap: string | undefined;

self.onmessage = async (ev: MessageEvent<Req>) => {
  const r = ev.data;
  let res: Res;
  if (!DRAW && idleTrap) {
    await ready;
    const why = idleTrap;
    idleTrap = undefined;
    sessions.clear();
    shipped.clear();
    await load().catch(() => undefined);
    (self as unknown as Worker).postMessage({ id: r.id, ok: false, error: `core trapped: ${why}` } as Res);
    return;
  }
  if (DRAW) {
    await ready;
    try {
      res = handleDraw(r);
    } catch (e) {
      res = { id: r.id, ok: false, error: `draw worker: ${e}` };
    }
    (self as unknown as Worker).postMessage(res);
    return;
  }
  try {
    await ready;
    // (a project that uses minted: Pyodide loaded before its first build,
    // as \\write18 runs synchronously inside it)
    if (r.op === "open" && usesMinted(r.files)) await loadMinted().catch((e) => console.warn("minted: not loaded:", e));
    if (r.op === "open" && r.engine === "xelatex") await loadXe();
    res = handle(r);
    shipPdf(r);
    // (the partex core draws pages only as draw lists, whatever the dpi)
    if (res.png && (("dpi" in r && r.dpi === 0) || (core.ph_assets && res.png[0] !== 0x89))) {
      res.draws = res.png.length ? JSON.parse(new TextDecoder().decode(res.png)) : undefined;
      delete res.png;
    } else if (res.png?.length) {
      const t = performance.now();
      const raw = res.png.length;
      res.png = await compress(res.png);
      if (res.json) Object.assign(res.json, { png_raw: raw, png_bytes: res.png.length, png_compress_ms: performance.now() - t });
    }
  } catch (e) {
    // A trap (a PhiTeX panic, with panic = "abort") leaves the instance
    // unusable: start a new one; every client must open again.
    // (and a core that fails to load at all says so: the reply always goes)
    // (XeTeX's PDF driver, xdvipdfmx, stops with a panic too: said so)
    const why = panicText();
    res = { id: r.id, ok: false, error: `${/partex_xdvipdfmx|xdvipdfmx/.test(why) ? "PDF driver failed" : "core trapped"}: ${e}${why}` };
    sessions.clear();
    await load().catch((l) => (res.error = `core failed to load: ${l}`));
  }
  const transfer = [res.png?.buffer, res.pdf?.buffer].filter((b): b is ArrayBuffer => !!b);
  (self as unknown as Worker).postMessage(res, transfer);
  // (after the reply: the engine readied for its first rebuild, so the
  // first keystroke after a cold build doesn't pay it; a message arriving
  // meanwhile waits that long, once per cold build)
  setTimeout(() => {
    try {
      // (readying the next rebuild: the tab says so, not "Typesetting", while it runs)
      (self as unknown as Worker).postMessage({ preparing: true });
      const did = core?.ph_idle?.() ?? 0;
      (self as unknown as Worker).postMessage({ preparing: false });
      // (the idle work changed the output, the trips that settle references
      // after one-trip keystrokes: the drawer gets the PDF, the tabs lay out again)
      if (did) {
        for (const c of sessions.keys()) shipFor(c);
        (self as unknown as Worker).postMessage({ settled: true });
      }
    } catch (e) {
      (self as unknown as Worker).postMessage({ preparing: false });
      // (told to the next request: see idleTrap)
      idleTrap = `${e} (readying the rebuilds)${panicText()}`;
    }
  }, 50);
};
