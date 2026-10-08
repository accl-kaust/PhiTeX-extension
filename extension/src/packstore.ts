// Shelf packs kept in this browser (the extension's origin: one IndexedDB
// for the offscreen document, the background and the popup). A pack is kept
// whole, as Shelf serves it (gzip), by its id, with when it was last used;
// past the cap (the popup's setting, kept here: an offscreen document has
// no chrome.storage) the least recently used go first, never one a project
// in this document is using.

const DB = "phitex-shelf";
/** (3: packs whole, by id, with use times; 2 kept every file apart, 1 Shelf's flat text files) */
const VERSION = 3;
export const DEFAULT_CAP_MB = 300;

export interface PackMeta {
  bytes: number;
  /** Last used (ms since the epoch). */
  used: number;
  uses: number;
  /** Fetched ahead (prefetch.ts), not because a project asked. */
  ahead?: boolean;
}

let opened: Promise<IDBDatabase> | undefined;

export function db(): Promise<IDBDatabase> {
  return (opened ??= new Promise<IDBDatabase>((res, rej) => {
    const o = indexedDB.open(DB, VERSION);
    o.onupgradeneeded = () => {
      for (const s of [...o.result.objectStoreNames]) o.result.deleteObjectStore(s);
      for (const s of ["packs", "meta", "kv"]) o.result.createObjectStore(s);
    };
    o.onsuccess = () => {
      // (another context upgrading: this one lets go, and opens again when next asked)
      o.result.onversionchange = () => {
        o.result.close();
        opened = undefined;
      };
      res(o.result);
    };
    o.onerror = () => rej(o.error);
  }).catch((e) => ((opened = undefined), Promise.reject(e))));
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = t.onabort = () => rej(t.error);
  });
}

export async function kvGet<T>(k: string): Promise<T | undefined> {
  return (await req((await db()).transaction("kv", "readonly").objectStore("kv").get(k))) as T | undefined;
}

export async function kvSet(k: string, v: unknown): Promise<void> {
  const t = (await db()).transaction("kv", "readwrite");
  t.objectStore("kv").put(v, k);
  await done(t);
}

export async function capBytes(): Promise<number> {
  return ((await kvGet<number>("capMB").catch(() => undefined)) ?? DEFAULT_CAP_MB) * 1048576;
}

/** A kept pack's bytes (gzip), marked used now (after: a read waits on no write); undefined if not kept. */
export async function getPack(id: string): Promise<Uint8Array | undefined> {
  const raw = (await req((await db()).transaction("packs", "readonly").objectStore("packs").get(id))) as Uint8Array | undefined;
  if (raw) void touch(id, raw.byteLength).catch(() => undefined);
  return raw;
}

async function touch(id: string, bytes: number): Promise<void> {
  const t = (await db()).transaction("meta", "readwrite");
  const s = t.objectStore("meta");
  const m = ((await req(s.get(id))) as PackMeta | undefined) ?? { bytes, used: 0, uses: 0 };
  s.put({ ...m, used: Date.now(), uses: m.uses + 1, ahead: false }, id);
  await done(t);
}

export async function hasPack(id: string): Promise<boolean> {
  return (await req((await db()).transaction("meta", "readonly").objectStore("meta").count(id))) > 0;
}

/** Keep a pack; `ahead`: fetched before any project asked (counts as used now, once). */
export async function putPack(id: string, raw: Uint8Array, ahead = false): Promise<void> {
  const t = (await db()).transaction(["packs", "meta"], "readwrite");
  t.objectStore("packs").put(raw, id);
  t.objectStore("meta").put({ bytes: raw.byteLength, used: Date.now(), uses: ahead ? 0 : 1, ahead } satisfies PackMeta, id);
  await done(t);
}

export async function allMeta(): Promise<Map<string, PackMeta>> {
  const t = (await db()).transaction("meta", "readonly").objectStore("meta");
  const [keys, vals] = await Promise.all([req(t.getAllKeys()), req(t.getAll())]);
  return new Map(keys.map((k, i) => [String(k), vals[i] as PackMeta]));
}

/** Drop the least recently used packs (not `keep`'s) until the kept ones fit `cap` bytes. */
export async function evict(keep: Set<string> = new Set(), cap?: number): Promise<number> {
  const limit = cap ?? (await capBytes());
  const all = await allMeta();
  let total = 0;
  for (const m of all.values()) total += m.bytes;
  if (total <= limit) return 0;
  const order = [...all].filter(([id]) => !keep.has(id)).sort((a, b) => a[1].used - b[1].used);
  const t = (await db()).transaction(["packs", "meta"], "readwrite");
  let n = 0;
  for (const [id, m] of order) {
    if (total <= limit) break;
    t.objectStore("packs").delete(id);
    t.objectStore("meta").delete(id);
    total -= m.bytes;
    n++;
  }
  await done(t);
  return n;
}

export async function clearPacks(): Promise<void> {
  const t = (await db()).transaction(["packs", "meta"], "readwrite");
  t.objectStore("packs").clear();
  t.objectStore("meta").clear();
  await done(t);
}
