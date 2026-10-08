// Shelf packs kept on this machine (the platform's store, platform.ts: the
// extension's IndexedDB in a browser, one for the offscreen document, the
// background and the popup; a folder of VS Code's global storage). A pack is
// kept whole, as Shelf serves it (gzip), by its id, with when it was last
// used; past the cap (the popup's setting, or VS Code's, kept here: an
// offscreen document has no chrome.storage) the least recently used go
// first, never one a project in this document is using.

import { platform } from "./platform.ts";

export const DEFAULT_CAP_MB = 300;

/** The stores: the packs' bytes, their metadata, and settings. */
const PACKS = "shelf.packs",
  META = "shelf.meta",
  KV = "shelf.kv";

export interface PackMeta {
  bytes: number;
  /** Last used (ms since the epoch). */
  used: number;
  uses: number;
  /** Fetched ahead (prefetch.ts), not because a project asked. */
  ahead?: boolean;
}

const kv = () => platform().kv;

export async function kvGet<T>(k: string): Promise<T | undefined> {
  return kv().get<T>(KV, k);
}

export async function kvSet(k: string, v: unknown): Promise<void> {
  await kv().write([[KV, k, v]]);
}

export async function capBytes(): Promise<number> {
  return ((await kvGet<number>("capMB").catch(() => undefined)) ?? DEFAULT_CAP_MB) * 1048576;
}

/** A kept pack's bytes (gzip), marked used now (after: a read waits on no write); undefined if not kept. */
export async function getPack(id: string): Promise<Uint8Array | undefined> {
  const raw = await kv().get<Uint8Array>(PACKS, id);
  if (raw) void touch(id, raw.byteLength).catch(() => undefined);
  return raw;
}

async function touch(id: string, bytes: number): Promise<void> {
  const m = (await kv().get<PackMeta>(META, id)) ?? { bytes, used: 0, uses: 0 };
  await kv().write([[META, id, { ...m, used: Date.now(), uses: m.uses + 1, ahead: false }]]);
}

export async function hasPack(id: string): Promise<boolean> {
  return (await kv().get(META, id)) !== undefined;
}

/** Keep a pack; `ahead`: fetched before any project asked (counts as used now, once). */
export async function putPack(id: string, raw: Uint8Array, ahead = false): Promise<void> {
  await kv().write([
    [PACKS, id, raw],
    [META, id, { bytes: raw.byteLength, used: Date.now(), uses: ahead ? 0 : 1, ahead } satisfies PackMeta],
  ]);
}

export async function allMeta(): Promise<Map<string, PackMeta>> {
  return kv().all<PackMeta>(META);
}

/** Drop the least recently used packs (not `keep`'s) until the kept ones fit `cap` bytes. */
export async function evict(keep: Set<string> = new Set(), cap?: number): Promise<number> {
  const limit = cap ?? (await capBytes());
  const all = await allMeta();
  let total = 0;
  for (const m of all.values()) total += m.bytes;
  if (total <= limit) return 0;
  const order = [...all].filter(([id]) => !keep.has(id)).sort((a, b) => a[1].used - b[1].used);
  const gone: [string, string, undefined][] = [];
  for (const [id, m] of order) {
    if (total <= limit) break;
    gone.push([PACKS, id, undefined], [META, id, undefined]);
    total -= m.bytes;
  }
  await kv().write(gone);
  return gone.length / 2;
}

export async function clearPacks(): Promise<void> {
  await kv().clear([PACKS, META]);
}
