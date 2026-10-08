// The browser extension's platform (common/src/platform.ts): its files by
// URL (this module is dist/platform.js, the extension's root one up: the
// same address chrome.runtime.getURL gives, in a worker too, which has no
// chrome.runtime), IndexedDB for the store (the extension's origin: one for
// the offscreen document, the background, the popup and the workers), and
// the browser's fetch. Every entry point imports it first, so it is set
// before a shared module asks; the content script never opens the store
// (its IndexedDB would be Overleaf's).

import { setPlatform, type KeyValue } from "./common/platform.ts";

const root = new URL("../", import.meta.url);
const url = (p: string) => new URL(p, root).href;

/** The databases, as they have always been named: a version change starts one empty. */
const DBS: Record<string, { name: string; version: number; stores: string[] }> = {
  /** (3: packs whole, by id, with use times; 2 kept every file apart, 1 Shelf's flat text files) */
  shelf: { name: "phitex-shelf", version: 3, stores: ["packs", "meta", "kv"] },
  release: { name: "phitex-release", version: 1, stores: ["kv"] },
};

const opened = new Map<string, Promise<IDBDatabase>>();

function db(key: string): Promise<IDBDatabase> {
  let p = opened.get(key);
  if (p) return p;
  const d = DBS[key];
  if (!d) return Promise.reject(new Error(`no database "${key}"`));
  p = new Promise<IDBDatabase>((res, rej) => {
    const o = indexedDB.open(d.name, d.version);
    o.onupgradeneeded = () => {
      for (const s of [...o.result.objectStoreNames]) o.result.deleteObjectStore(s);
      for (const s of d.stores) o.result.createObjectStore(s);
    };
    o.onsuccess = () => {
      // (another context upgrading: this one lets go, and opens again when next asked)
      o.result.onversionchange = () => {
        o.result.close();
        opened.delete(key);
      };
      res(o.result);
    };
    o.onerror = () => rej(o.error);
  }).catch((e) => (opened.delete(key), Promise.reject(e)));
  opened.set(key, p);
  return p;
}

/** "shelf.packs" → its database and store. */
const split = (s: string): [string, string] => {
  const i = s.indexOf(".");
  return [s.slice(0, i), s.slice(i + 1)];
};

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

/** One transaction over `stores` (one database's). */
async function tx(stores: string[], mode: IDBTransactionMode): Promise<{ t: IDBTransaction; s: (store: string) => IDBObjectStore }> {
  const [d] = split(stores[0]);
  const t = (await db(d)).transaction([...new Set(stores.map((s) => split(s)[1]))], mode);
  return { t, s: (store) => t.objectStore(split(store)[1]) };
}

const idb: KeyValue = {
  async get<T>(store: string, key: string) {
    const { s } = await tx([store], "readonly");
    return (await req(s(store).get(key))) as T | undefined;
  },
  async all<T>(store: string) {
    const { s } = await tx([store], "readonly");
    const [keys, vals] = await Promise.all([req(s(store).getAllKeys()), req(s(store).getAll())]);
    return new Map(keys.map((k, i) => [String(k), vals[i] as T]));
  },
  async write(ops) {
    if (!ops.length) return;
    const { t, s } = await tx(ops.map(([store]) => store), "readwrite");
    for (const [store, key, v] of ops) v === undefined ? s(store).delete(key) : s(store).put(v, key);
    await done(t);
  },
  async clear(stores) {
    const { t, s } = await tx(stores, "readwrite");
    for (const store of stores) s(store).clear();
    await done(t);
  },
};

setPlatform({
  asset: (p) => fetch(url(p)),
  assetUrl: url,
  kv: idb,
  fetch: (u, init) => fetch(u, init),
  saveData: () => !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData,
});
