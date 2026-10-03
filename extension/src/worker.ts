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
  | { id: number; client: string; op: "open"; main: string; files: Record<string, string>; fuel: number }
  | { id: number; client: string; op: "edit"; file: string; start: number; end: number; text: string; page: number; dpi: number }
  | { id: number; client: string; op: "set_file"; file: string; text: string }
  | { id: number; client: string; op: "set_bytes"; file: string; bytes: Uint8Array }
  | { id: number; client: string; op: "png"; page: number; dpi: number }
  | { id: number; client: string; op: "pdf" }
  | { id: number; client: string; op: "status" }
  | { id: number; client: string; op: "log" }
  | { id: number; client: string; op: "go" }
  | { id: number; client: string; op: "pages" }
  | { id: number; client: string; op: "check"; file?: string; expect?: string }
  | { id: number; client: string; op: "close" };

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
  /** The partex core: the LaTeX format and fonts (assets.bin.gz, gunzipped). */
  ph_assets?(p: number, n: number): number;
  ph_alloc(n: number): number;
  ph_free(p: number, n: number): void;
  ph_out_ptr(): number;
  ph_out_len(): number;
  ph_open(p: number, n: number): number;
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
  ph_go?(h: number): void;
  ph_idle?(): number;
  ph_pages(h: number): void;
  ph_text(h: number, p: number, n: number): void;
  _initialize?(): void;
}

class Exit extends Error {}

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
  (assets ??= fetch(new URL("assets.bin.gz", import.meta.url)).then(async (r) => {
    if (!r.ok) throw new Error(`assets: ${r.status}`);
    return new Uint8Array(await new Response(r.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  }));

async function load(): Promise<void> {
  module ??= await WebAssembly.compileStreaming(fetch(new URL("core.wasm", import.meta.url)));
  let memory: WebAssembly.Memory | undefined;
  const inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi(() => memory!) });
  core = inst.exports as unknown as Core;
  memory = core.memory;
  core._initialize?.();
  if (core.ph_assets) {
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
      if (h) core.ph_close(h);
      const f = new Frame().u32(r.fuel).str(r.main).u32(Object.keys(r.files).length);
      for (const [n, t] of Object.entries(r.files)) f.str(n).str(t);
      const nh = call(f, (p, n) => core.ph_open(p, n));
      const json = outJson();
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
    case "status":
      core.ph_status(h);
      return { id: r.id, ok: true, json: outJson() };
    case "go":
      // (the discovery pass's files are fetched: the first paint may build)
      core.ph_go?.(h);
      return { id: r.id, ok: true };
    case "log":
      // (debugging: the whole terminal and the job's .log)
      if (!core.ph_log) return { id: r.id, ok: false, error: "this core keeps no log" };
      core.ph_log(h);
      return { id: r.id, ok: true, json: { log: new TextDecoder().decode(outBytes()) } };
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

self.onmessage = async (ev: MessageEvent<Req>) => {
  const r = ev.data;
  let res: Res;
  try {
    await ready;
    res = handle(r);
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
    res = { id: r.id, ok: false, error: `core trapped: ${e}` };
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
      core?.ph_idle?.();
    } catch {
      /* a trap here shows on the next request */
    }
  }, 50);
};
