// Packs fetched ahead, in the background, so a project's first open finds
// them here: the packs of the files most arXiv papers load (with what those
// load and their fonts), beyond the ones the extension ships. The list is
// Shelf's (release.json's `prefetch`, so it changes without a new
// extension), else the extension's own (packs/ahead.txt: the files that
// cover 95% of the arXiv papers surveyed whole, bench/arxiv/coverage.py), by
// file name, not pack: a new release's packs follow by the index. Everyone fetches the same
// list, so it says nothing of anyone's papers.
//
// One pack at a time; at most AHEAD_SHARE of the cache's cap, so the packs
// projects ask for keep room (and the oldest of those, prefetched or not,
// go first past the cap, packstore.ts). Not on a Save-Data connection, nor
// with the popup's switch off. Run by the background (install, browser
// start, and every few hours: a run cut short, the service worker stopped,
// goes on from where it was, as packs kept are skipped).

import { formatOf } from "./resolve.ts";
import { latest } from "./release.ts";
import { fetchPack, index, shipped } from "./shelf.ts";
import { allMeta, capBytes, kvGet, kvSet, putPack } from "./packstore.ts";

const AHEAD_SHARE = 0.8;

export interface Ahead {
  /** Packs of the list kept (here or shipped), of `total`. */
  have: number;
  total: number;
  /** Bytes of the list's packs kept here. */
  bytes: number;
  state: "running" | "done" | "full" | "off" | "error";
  error?: string;
}

/** The list: Shelf's, else the extension's. */
async function names(): Promise<string[]> {
  const r = await latest();
  if (r?.prefetch?.length) return r.prefetch;
  const t = await fetch(chrome.runtime.getURL("packs/ahead.txt")).then((x) => (x.ok ? x.text() : ""), () => "");
  return t.split("\n").filter((l) => l && !l.startsWith("#"));
}

let running: Promise<void> | undefined;

/** Fetch what's missing of the list (once at a time); `tell`: progress, after each pack. */
export function prefetch(tell: (a: Ahead) => void = () => undefined): Promise<void> {
  return (running ??= run(tell).finally(() => (running = undefined)));
}

async function run(tell: (a: Ahead) => void): Promise<void> {
  if (await kvGet<boolean>("aheadOff").catch(() => false)) return tell({ have: 0, total: 0, bytes: 0, state: "off" });
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  const ix = await index();
  const ids = new Set<string>();
  for (const line of await names()) {
    const [name, engine = "pdftex"] = line.split("\t");
    const path = ix.resolve(name, formatOf(name), engine);
    if (path) for (const id of ix.packs(path, engine)) ids.add(id);
  }
  const bundled = await shipped();
  const want = [...ids].filter((id) => !bundled.has(id));
  const kept = await allMeta();
  const budget = (await capBytes()) * AHEAD_SHARE;
  let used = 0;
  for (const m of kept.values()) used += m.bytes;
  const a: Ahead = { have: ids.size - want.length, total: ids.size, bytes: 0, state: "running" };
  for (const id of want) {
    const m = kept.get(id);
    if (m) {
      a.have++;
      a.bytes += m.bytes;
    }
  }
  tell(a);
  for (const id of want) {
    if (kept.has(id)) continue;
    let raw: Uint8Array;
    try {
      raw = await fetchPack(id);
    } catch (e) {
      // (one pack Shelf lacks: the rest still come)
      a.error = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (used + raw.byteLength > budget) return tell({ ...a, state: "full" });
    await putPack(id, raw, true);
    used += raw.byteLength;
    a.have++;
    a.bytes += raw.byteLength;
    tell(a);
  }
  tell({ ...a, state: a.error ? "error" : "done" });
}

export async function setAheadOff(off: boolean): Promise<void> {
  await kvSet("aheadOff", off);
}
