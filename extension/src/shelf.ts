// Where packages come from, in the offscreen document (the extension's
// origin: no Overleaf CSP, and Shelf allows any origin, so no host
// permission). A name is looked up in order:
//
//   1. the extension's own texmf/ (the LaTeX kernel and the common packages);
//   2. IndexedDB (fetched before: once per browser, not per project);
//   3. Shelf (shelf-phitex.pages.dev): TeX Live's files, one URL per name.
//
// Shelf is asked only for names its names.txt lists, so a project's own
// file names (an \input of a file it lacks) never leave the browser.

// (Cloudflare Pages' own address until there is a domain: shelf.phitex.org)
export const SHELF = "https://shelf-phitex.pages.dev/tl2026/";

const once = <T>(f: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f().catch((e) => ((p = undefined), Promise.reject(e))));
};

const names = (t: string) => new Set(t.split("\n").filter(Boolean));
const bundled = once(async () => names(await (await fetch(chrome.runtime.getURL("texmf/names.txt"))).text()));
const shelfNames = once(async () => {
  const hit = await idb("get", "names.txt");
  if (typeof hit === "string") return names(hit);
  const r = await fetch(SHELF + "names.txt");
  if (!r.ok) throw new Error(`Shelf: ${r.status}`);
  const t = await r.text();
  await idb("put", "names.txt", t);
  return names(t);
});

const db = once(
  () =>
    new Promise<IDBDatabase>((res, rej) => {
      const o = indexedDB.open("phitex-shelf", 1);
      o.onupgradeneeded = () => o.result.createObjectStore("files");
      o.onsuccess = () => res(o.result);
      o.onerror = () => rej(o.error);
    }),
);

/** The `tl2026/` store: a name's text (get), or kept (put). */
async function idb(op: "get" | "put", name: string, text?: string): Promise<unknown> {
  const key = SHELF + name;
  const s = (await db()).transaction("files", op === "get" ? "readonly" : "readwrite").objectStore("files");
  const r = op === "get" ? s.get(key) : s.put(text, key);
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

/** `name`'s text, and where it came from; null: in neither texmf/ nor Shelf. */
export async function resolve(name: string): Promise<{ text: string; from: string } | null> {
  if (name.includes("/") || name.startsWith(".")) return null;
  if ((await bundled()).has(name)) return { text: await (await fetch(chrome.runtime.getURL("texmf/" + name))).text(), from: "bundled" };
  const hit = await idb("get", name).catch(() => undefined);
  if (typeof hit === "string") return { text: hit, from: "cache" };
  if (!(await shelfNames()).has(name)) return null;
  const r = await fetch(SHELF + encodeURIComponent(name));
  if (!r.ok) throw new Error(`Shelf: ${name}: ${r.status}`);
  const text = await r.text();
  await idb("put", name, text).catch(() => undefined);
  return { text, from: "shelf" };
}
