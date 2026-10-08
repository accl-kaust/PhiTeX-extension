// Shelf's index (name → pack), kept up to date without a new extension.
//
// Shelf publishes release.json, the one file of it that changes:
//   {"release": "tl2026.3", "index": "index-tl2026.3.tsv.gz", "schema": 3,
//    "min_extension": "0.3.0", "notice": null, "deps": ["pdftex", "xetex"],
//    "search": {"pdftex": {"tex": ["tex/latex", …], …}, "xetex": {…}}}
// and every release's index and packs, which never change (packs are named
// by their content, under h/). The extension ships an index (the fallback,
// offline and on first run); at most once a day it reads release.json, and
// a newer release whose schema it reads (3: every file by its texmf path,
// resolved per engine by `search`, resolve.ts) has its index fetched and
// kept in IndexedDB with its release.json: the next worker reads those. The
// shipped index comes with its release.json (shelf-release.json). `min_extension` and `notice` go to
// the tabs (an update asked for, a line shown); the extension keeps
// working either way (its index's packs stay on Shelf).
//
// Used by the offscreen document and the workers (the extension's origin,
// one IndexedDB).

import { SHELF } from "./shelf.ts";
export { older } from "./version.ts";

import type { ReleaseMeta } from "./resolve.ts";

/** The index and pack format this extension reads (3: files by texmf path, per-engine search and deps; packs by content under h/). */
export const SCHEMA = 3;

export interface Release extends ReleaseMeta {
  release: string;
  index: string;
  schema: number;
  min_extension?: string;
  notice?: string | null;
  /** The files to fetch ahead (prefetch.ts), most papers' first: "name" or "name<TAB>engine" (Shelf's: xetex). */
  prefetch?: string[];
}

const DAY = 24 * 3600 * 1000;

function meta(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const o = indexedDB.open("phitex-release", 1);
    o.onupgradeneeded = () => o.result.createObjectStore("kv");
    o.onsuccess = () => res(o.result);
    o.onerror = () => rej(o.error);
  });
}

async function get<T>(k: string): Promise<T | undefined> {
  const s = (await meta()).transaction("kv", "readonly").objectStore("kv");
  return new Promise((res, rej) => {
    const r = s.get(k);
    r.onsuccess = () => res(r.result as T | undefined);
    r.onerror = () => rej(r.error);
  });
}

async function put(entries: [string, unknown][]): Promise<void> {
  const t = (await meta()).transaction("kv", "readwrite");
  for (const [k, v] of entries) t.objectStore("kv").put(v, k);
  await new Promise<void>((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

/**
 * The index to use (gzipped TSV) and its release.json: the newest release
 * fetched, else the one shipped (`shipped(name)`: the extension's file).
 */
export async function indexBytes(shipped: (name: string) => Promise<Response>): Promise<{ gz: ReadableStream; release: string; meta: ReleaseMeta }> {
  try {
    const have = await get<{ release: string; gz: Blob; meta?: ReleaseMeta }>("index");
    if (have?.meta?.schema === SCHEMA) return { gz: have.gz.stream(), release: have.release, meta: have.meta };
  } catch {
    // (no IndexedDB: a private window's limits; the shipped one)
  }
  const r = await shipped("shelf-index.tsv.gzdata");
  if (!r.ok) throw new Error(`shelf index: ${r.status}`);
  const meta = (await shipped("shelf-release.json").then((m) => m.json())) as ReleaseMeta;
  return { gz: r.body!, release: "shipped", meta };
}

/**
 * Read release.json if a day has passed since the last look (or `force`),
 * and keep a newer release's index if this extension reads its schema.
 * The release as Shelf has it now (or as last seen), for the tabs.
 */
export async function refresh(force = false): Promise<Release | undefined> {
  const seen = await get<{ at: number; r: Release }>("seen").catch(() => undefined);
  if (!force && seen && Date.now() - seen.at < DAY) return seen.r;
  let r: Release;
  try {
    const res = await fetch(SHELF + "release.json", { cache: "no-cache" });
    if (!res.ok) return seen?.r;
    r = (await res.json()) as Release;
  } catch {
    return seen?.r;
  }
  const entries: [string, unknown][] = [["seen", { at: Date.now(), r }]];
  // (none fetched yet: the shipped one's release, not fetched again)
  const have =
    (await get<{ release: string }>("index").catch(() => undefined))?.release ??
    (await fetch(chrome.runtime.getURL("shelf-release.json")).then((x) => x.json() as Promise<{ release?: string }>).then((m) => m.release, () => undefined));
  // (schema 3 only: an index of another schema is not this extension's to read)
  if (r.schema === SCHEMA && r.release !== have) {
    const gz = await fetch(SHELF + r.index).then((x) => (x.ok ? x.blob() : null), () => null);
    // (an index is gzip: one that isn't, a 404 page served as 200, is not kept)
    if (gz && gz.size > 2) {
      const head = new Uint8Array(await gz.slice(0, 2).arrayBuffer());
      if (head[0] === 0x1f && head[1] === 0x8b) entries.push(["index", { release: r.release, gz, meta: r }]);
    }
  }
  await put(entries).catch(() => undefined);
  return r;
}

/** The release as last seen (refresh), if any. */
export async function latest(): Promise<Release | undefined> {
  return (await get<{ r: Release }>("seen").catch(() => undefined))?.r;
}

/** A pack's address: by its content, under h/. */
export function packUrl(id: string): string {
  return SHELF + "h/" + encodeURIComponent(id) + ".pack";
}
