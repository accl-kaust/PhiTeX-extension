// Shelf's index (name → pack), kept up to date without a new extension.
//
// Shelf publishes release.json, the one file of it that changes:
//   {"release": "tl2026.3", "index": "index-tl2026.3.tsv.gz", "schema": 2,
//    "min_extension": "0.2.0", "notice": null}
// and every release's index and packs, which never change (packs are named
// by their content, under h/). The extension ships an index (the fallback,
// offline and on first run); at most once a day it reads release.json, and
// a newer release whose schema it reads has its index fetched and kept in
// IndexedDB: the next worker reads that. `min_extension` and `notice` go to
// the tabs (an update asked for, a line shown); the extension keeps
// working either way (its index's packs stay on Shelf).
//
// Used by the offscreen document and the workers (the extension's origin,
// one IndexedDB).

import { SHELF } from "./shelf.ts";
export { older } from "./version.ts";

/** The index and pack format this extension reads (2: hashed packs under h/). */
export const SCHEMA = 2;

export interface Release {
  release: string;
  index: string;
  schema: number;
  min_extension?: string;
  notice?: string | null;
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

/** The index to use (gzipped TSV): the newest release fetched, else the one shipped. */
export async function indexBytes(shipped: () => Promise<Response>): Promise<{ gz: ReadableStream; release: string }> {
  try {
    const have = await get<{ release: string; gz: Blob }>("index");
    if (have) return { gz: have.gz.stream(), release: have.release };
  } catch {
    // (no IndexedDB: a private window's limits; the shipped one)
  }
  const r = await shipped();
  if (!r.ok) throw new Error(`shelf index: ${r.status}`);
  return { gz: r.body!, release: "shipped" };
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
  const have = await get<{ release: string }>("index").catch(() => undefined);
  if (r.schema <= SCHEMA && r.release !== have?.release) {
    const gz = await fetch(SHELF + r.index).then((x) => (x.ok ? x.blob() : null), () => null);
    // (an index is gzip: one that isn't, a 404 page served as 200, is not kept)
    if (gz && gz.size > 2) {
      const head = new Uint8Array(await gz.slice(0, 2).arrayBuffer());
      if (head[0] === 0x1f && head[1] === 0x8b) entries.push(["index", { release: r.release, gz }]);
    }
  }
  await put(entries).catch(() => undefined);
  return r;
}

/** A pack's address: released packs (by content) under h/, a build's under p/. */
export function packUrl(id: string): string {
  return SHELF + (/-[0-9a-f]{12}$/.test(id) ? "h/" : "p/") + encodeURIComponent(id) + ".pack";
}
