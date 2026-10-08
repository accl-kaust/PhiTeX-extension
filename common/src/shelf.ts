// Where packages come from, in the core's host (corehost.ts: the offscreen
// document, the extension's origin: no Overleaf CSP, and Shelf allows any
// origin, so no host permission; or VS Code's extension host). A name is
// looked up in order:
//
//   1. the extension's own texmf/ (the LaTeX kernel) and packs/ (the packs
//      of the packages arXiv papers use most);
//   2. the packs kept on this machine (packstore.ts: fetched before, by a
//      project or ahead of one by prefetch.ts; no request);
//   3. Shelf (shelf-phitex.pages.dev): TeX Live's files in packs, one per
//      package (or per part of a big one), fetched whole: a .sty comes with
//      the .def, .cfg and .fd files it reads, and the pack is kept.
//
// Which file a name is, for the project's engine, and which pack holds it,
// is in an index the extension holds (shipped, and newer releases of it
// fetched daily, release.ts; the rule is resolve.ts's, the worker's too):
// no request to learn it, and a name the index lacks (a project's own file
// it doesn't have) never leaves the machine.

// (Cloudflare Pages' own address until there is a domain: shelf.phitex.org)
export const SHELF = "https://shelf-phitex.pages.dev/tl2026/";

import { indexBytes, packUrl } from "./release.ts";
import { Index, formatOf, shelfEngine } from "./resolve.ts";
import { evict, getPack, putPack } from "./packstore.ts";
import { platform } from "./platform.ts";

const once = <T>(f: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f().catch((e) => ((p = undefined), Promise.reject(e))));
};

const gunzip = async (r: Response) => new Uint8Array(await new Response(r.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());

const names = (t: string) => new Set(t.split("\n").filter(Boolean));
const bundled = once(async () => names(await (await platform().asset("texmf/names.txt")).text()));
/** What the core's assets hold (the format, fonts, the popular packages): never fetched. */
const inCore = once(async () => names(await (await platform().asset("dist/assets-names.txt")).text()));

/** Path → pack, from Shelf's newest release this extension has (release.ts), else its own copy. */
export const index = once(async () => {
  const { gz, meta } = await indexBytes();
  return new Index(await new Response(gz.pipeThrough(new DecompressionStream("gzip"))).text(), meta);
});

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

/** Each pack read once per document (in flight or done): its files, and where it came from. */
const packs = new Map<string, Promise<{ files: Map<string, Uint8Array>; from: "bundled" | "cache" | "shelf" }>>();
/** Shelf packs the extension ships (packs/list.txt): read from it, not Shelf. */
export const shipped = once(async () => {
  const r = await platform().asset("packs/list.txt").catch(() => null);
  return new Set(r?.ok ? (await r.text()).split("\n").filter(Boolean) : []);
});

const isGzip = (b: Uint8Array) => b[0] === 0x1f && b[1] === 0x8b;

/** A pack Shelf serves, as is (gzip); `priority` "low" for one fetched ahead (a project's own go first). */
export async function fetchPack(id: string, priority: RequestPriority = "auto"): Promise<Uint8Array> {
  const get = async (cache: RequestCache) => {
    const r = await platform().fetch(packUrl(id), { cache, priority });
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : new Uint8Array();
  };
  // (a pack Shelf doesn't have comes back as its home page, 200, and the
  // browser keeps that a year (packs are immutable): asked again past the
  // cache, as a pack deployed since then is there)
  let raw = await get("default");
  if (!isGzip(raw)) raw = await get("reload");
  if (!raw.length) throw new Error(`Shelf has no pack "${id}" (HTTP error)`);
  if (!isGzip(raw)) throw new Error(`Shelf has no pack "${id}" (the package server is older than this extension)`);
  return raw;
}

/**
 * A Shelf pack as served (gzip): kept on this machine, no request; else
 * Shelf's, kept, and the cache kept under its cap (never evicting a pack
 * this document has read). Also what VS Code's workers read mid-build.
 */
export async function packRaw(id: string): Promise<{ raw: Uint8Array; from: "cache" | "shelf" }> {
  const kept = await getPack(id).catch(() => undefined);
  const raw = kept ?? (await fetchPack(id));
  if (!kept) await putPack(id, raw).then(() => evict(new Set([...packs.keys(), id]))).catch(() => undefined);
  return { raw, from: kept ? "cache" : "shelf" };
}

function pack(id: string) {
  let p = packs.get(id);
  if (!p) {
    p = (async () => {
      if ((await shipped()).has(id)) {
        const r = await platform().asset(`packs/${id}.pack`);
        return { files: new Map(unpack(await gunzip(r))), from: "bundled" as const };
      }
      const { raw, from } = await packRaw(id);
      return { files: new Map(unpack(await gunzip(new Response(raw as BlobPart)))), from };
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
 * for `engine` (the extension's: pdflatex, xelatex), and `extra`: the other
 * files of its pack and of the packs its loading reads with that engine
 * (Shelf's trace), each pack's once, by texmf path. The build stops at the first file
 * it lacks, so the core gets them all before it asks: a package and what it
 * loads in one round, not a build each.
 */
export async function resolve(name: string, engine?: string): Promise<(Resolved & { extra?: [string, Uint8Array][] }) | null> {
  if (name.includes("/") || name.startsWith(".")) return null;
  if ((await inCore().catch(() => new Set<string>())).has(name)) return { from: "core", inCore: true };
  const e = shelfEngine(engine);
  const ix = await index();
  const path = ix.resolve(name, formatOf(name), e);
  // (the bundled texmf/, unless the engine's own tree has the file first, as the worker decides)
  if ((await bundled()).has(name) && !(path && /^tex\/(xe|lua)(la)?tex\//.test(path)))
    return { text: await (await platform().asset("texmf/" + name)).text(), from: "bundled" };
  if (!path) return null;
  const [own, ...deps] = ix.packs(path, e);
  const ids = [own, ...deps].filter((id) => !given.has(id));
  for (const id of ids) given.add(id);
  const got = await Promise.all(ids.map((id) => pack(id).then((p) => p.files, () => new Map<string, Uint8Array>())));
  const extra: [string, Uint8Array][] = got.flatMap((m) => [...m].filter(([n]) => n !== path));
  const p = await pack(own);
  const b = p.files.get(path);
  return b ? { ...asFile(name, b), from: p.from === "shelf" ? "shelf" : "cache", extra } : null;
}
