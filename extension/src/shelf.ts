// Where packages come from, in the offscreen document (the extension's
// origin: no Overleaf CSP, and Shelf allows any origin, so no host
// permission). A name is looked up in order:
//
//   1. the extension's own texmf/ (the LaTeX kernel and the common packages);
//   2. IndexedDB (fetched before: once per browser, not per project);
//   3. Shelf (shelf-phitex.pages.dev): TeX Live's files in packs, one per
//      package (or per part of a big one), fetched whole: a .sty comes with
//      the .def, .cfg and .fd files it reads, and every file of the pack is
//      kept in IndexedDB.
//
// Which pack holds a name is in the extension (shelf-index.tsv.gz, made by
// Shelf's build): no request to learn it, and a name the index lacks (a
// project's own file it doesn't have) never leaves the browser.

// (Cloudflare Pages' own address until there is a domain: shelf.phitex.org)
export const SHELF = "https://shelf-phitex.pages.dev/tl2026/";

const once = <T>(f: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f().catch((e) => ((p = undefined), Promise.reject(e))));
};

const gunzip = async (r: Response) => new Uint8Array(await new Response(r.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());

const names = (t: string) => new Set(t.split("\n").filter(Boolean));
const bundled = once(async () => names(await (await fetch(chrome.runtime.getURL("texmf/names.txt"))).text()));
/** What the core's assets hold (the format, fonts, the popular packages): never fetched. */
const inCore = once(async () => names(await (await fetch(chrome.runtime.getURL("dist/assets-names.txt"))).text()));

/** Name → pack, from the extension's copy of Shelf's index. */
const index = once(async () => {
  const r = await fetch(chrome.runtime.getURL("shelf-index.tsv.gz"));
  if (!r.ok) throw new Error(`shelf index: ${r.status}`);
  const m = new Map<string, Row>();
  for (const line of new TextDecoder().decode(await gunzip(r)).split("\n")) {
    const [name, pack, deps] = line.split("\t");
    if (name && pack) m.set(name, { pack, deps: deps ? deps.split(",") : [] });
  }
  return m;
});

const db = once(
  () =>
    new Promise<IDBDatabase>((res, rej) => {
      // (2: files as bytes, from packs; 1 held text from Shelf's flat files)
      const o = indexedDB.open("phitex-shelf", 2);
      o.onupgradeneeded = () => {
        if (o.result.objectStoreNames.contains("files")) o.result.deleteObjectStore("files");
        o.result.createObjectStore("files");
      };
      o.onsuccess = () => res(o.result);
      o.onerror = () => rej(o.error);
    }),
);

async function idbGet(name: string): Promise<Uint8Array | undefined> {
  const s = (await db()).transaction("files", "readonly").objectStore("files");
  const r = s.get(SHELF + name);
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result instanceof Uint8Array ? r.result : undefined);
    r.onerror = () => rej(r.error);
  });
}

async function idbPutAll(files: [string, Uint8Array][]): Promise<void> {
  const t = (await db()).transaction("files", "readwrite");
  const s = t.objectStore("files");
  for (const [n, b] of files) s.put(b, SHELF + n);
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

/** A pack's files: gzip of `u32 n, (u32 len, name, u32 len, bytes) × n`. */
function unpack(b: Uint8Array): [string, Uint8Array][] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dec = new TextDecoder();
  const out: [string, Uint8Array][] = [];
  let at = 4;
  for (let n = dv.getUint32(0, true); n > 0; n--) {
    const k = dv.getUint32(at, true);
    const name = dec.decode(b.subarray(at + 4, at + 4 + k));
    at += 4 + k;
    const l = dv.getUint32(at, true);
    out.push([name, b.slice(at + 4, at + 4 + l)]);
    at += 4 + l;
  }
  return out;
}

/** Each pack fetched once (in flight or done), its files kept. */
const packs = new Map<string, Promise<Map<string, Uint8Array>>>();
/** Index rows: a name's pack, and the packs its loading reads (Shelf's trace). */
type Row = { pack: string; deps: string[] };
function pack(id: string): Promise<Map<string, Uint8Array>> {
  let p = packs.get(id);
  if (!p) {
    p = (async () => {
      const url = SHELF + "p/" + encodeURIComponent(id) + ".pack";
      const get = async (cache: RequestCache) => {
        const r = await fetch(url, { cache });
        return r.ok ? new Uint8Array(await r.arrayBuffer()) : new Uint8Array();
      };
      // (a pack Shelf doesn't have comes back as its home page, 200, and the
      // browser keeps that a year (packs are immutable): asked again past the
      // cache, as a pack deployed since then is there)
      let raw = await get("default");
      if (raw[0] !== 0x1f || raw[1] !== 0x8b) raw = await get("reload");
      if (!raw.length) throw new Error(`Shelf has no pack "${id}" (HTTP error)`);
      if (raw[0] !== 0x1f || raw[1] !== 0x8b) throw new Error(`Shelf has no pack "${id}" (the package server is older than this extension)`);
      const files = unpack(await gunzip(new Response(raw)));
      await idbPutAll(files).catch(() => undefined);
      return new Map(files);
    })();
    p.catch(() => packs.delete(id));
    packs.set(id, p);
  }
  return p;
}

/** Text if it is UTF-8 and not a font's metrics; else bytes (handed to the core apart). */
function asFile(name: string, b: Uint8Array): { text?: string; bytes?: Uint8Array } {
  if (/\.(tfm|vf)$/i.test(name)) return { bytes: b };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(b) };
  } catch {
    return { bytes: b };
  }
}

export type Resolved = { text?: string; bytes?: Uint8Array; from: "bundled" | "cache" | "shelf" | "core"; inCore?: boolean };

/** Packs whose files were handed out already (by `resolve`'s `extra`). */
const given = new Set<string>();

/**
 * `name`'s file and where it came from (null: in neither texmf/ nor Shelf),
 * and `extra`: the other files of its pack and of the packs its loading
 * reads (Shelf's trace), each pack's once. The build stops at the first file
 * it lacks, so the core gets them all before it asks: a package and what it
 * loads in one round, not a build each.
 */
export async function resolve(name: string): Promise<(Resolved & { extra?: [string, Uint8Array][] }) | null> {
  if (name.includes("/") || name.startsWith(".")) return null;
  if ((await inCore().catch(() => new Set<string>())).has(name)) return { from: "core", inCore: true };
  if ((await bundled()).has(name)) return { text: await (await fetch(chrome.runtime.getURL("texmf/" + name))).text(), from: "bundled" };
  const row = (await index()).get(name);
  const hit = await idbGet(name).catch(() => undefined);
  if (!row) return hit ? { ...asFile(name, hit), from: "cache" } : null;
  const ids = [row.pack, ...row.deps].filter((id) => !given.has(id));
  for (const id of ids) given.add(id);
  const got = await Promise.all(ids.map((id) => pack(id).catch(() => new Map<string, Uint8Array>())));
  const extra: [string, Uint8Array][] = got.flatMap((m) => [...m].filter(([n]) => n !== name));
  const b = hit ?? (await pack(row.pack)).get(name);
  return b ? { ...asFile(name, b), from: hit ? "cache" : "shelf", extra } : null;
}
