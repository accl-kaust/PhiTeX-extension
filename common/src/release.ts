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
// kept (the platform's store: IndexedDB, VS Code's global storage) with its
// release.json: the next worker reads those. The
// shipped index comes with its release.json (shelf-release.json). `min_extension` and `notice` go to
// the tabs (an update asked for, a line shown); the extension keeps
// working either way (its index's packs stay on Shelf).
//
// Used by the core's host and the workers (corehost.ts, worker.ts: one store).

import { SHELF } from "./shelf.ts";
import { platform } from "./platform.ts";
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

const KV = "release.kv";
const get = <T>(k: string) => platform().kv.get<T>(KV, k);
const put = (entries: [string, unknown][]) => platform().kv.write(entries.map(([k, v]) => [KV, k, v]));

/**
 * The index to use (gzipped TSV) and its release.json: the newest release
 * fetched, else the one shipped (the extension's file).
 */
export async function indexBytes(): Promise<{ gz: ReadableStream; release: string; meta: ReleaseMeta }> {
  const shipped = (name: string) => platform().asset(name);
  try {
    // (gz: bytes; an older version kept a Blob)
    const have = await get<{ release: string; gz: Uint8Array | Blob; meta?: ReleaseMeta }>("index");
    if (have?.meta?.schema === SCHEMA) return { gz: (have.gz instanceof Blob ? have.gz : new Blob([have.gz as BlobPart])).stream(), release: have.release, meta: have.meta };
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
    const res = await platform().fetch(SHELF + "release.json", { cache: "no-cache" });
    if (!res.ok) return seen?.r;
    r = (await res.json()) as Release;
  } catch {
    return seen?.r;
  }
  const entries: [string, unknown][] = [["seen", { at: Date.now(), r }]];
  // (none fetched yet: the shipped one's release, not fetched again)
  const have =
    (await get<{ release: string }>("index").catch(() => undefined))?.release ??
    (await platform().asset("shelf-release.json").then((x) => x.json() as Promise<{ release?: string }>).then((m) => m.release, () => undefined));
  // (schema 3 only: an index of another schema is not this extension's to read)
  if (r.schema === SCHEMA && r.release !== have) {
    const gz = await platform().fetch(SHELF + r.index).then(async (x) => (x.ok ? new Uint8Array(await x.arrayBuffer()) : null), () => null);
    // (an index is gzip: one that isn't, a 404 page served as 200, is not kept)
    if (gz && gz.length > 2 && gz[0] === 0x1f && gz[1] === 0x8b) entries.push(["index", { release: r.release, gz, meta: r }]);
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
