// What the shared code needs of where it runs: the extension's own files,
// a store kept on this machine, and the network. The browser extension's
// pages and workers (overleaf/src/platform.ts: its files by URL, IndexedDB)
// and VS Code's extension host and worker threads (vscode/src/platform.ts:
// its files on disk, a folder in its global storage) each set one, before
// anything asks; the shared code never names chrome.* or node:*.

/**
 * Stores of keys and values (a value: what structured clone keeps, bytes
 * included). Store names are `db.store`: "shelf.packs", "shelf.meta",
 * "shelf.kv", "release.kv"; one `write` touches one db's stores, at once.
 */
export interface KeyValue {
  get<T>(store: string, key: string): Promise<T | undefined>;
  /** Every key and value of a store (a small one: the packs' metadata). */
  all<T>(store: string): Promise<Map<string, T>>;
  /** Puts, and deletes (value undefined), all or none. */
  write(ops: [store: string, key: string, value: unknown][]): Promise<void>;
  clear(stores: string[]): Promise<void>;
}

export interface Platform {
  /** One of the extension's own files, by its path from the extension's root ("texmf/names.txt", "dist/core.wasm"). */
  asset(path: string): Promise<Response>;
  /** Its URL: a module to import, a file to give by address. */
  assetUrl(path: string): string;
  kv: KeyValue;
  /** fetch, as the host makes it (`cache`, `priority`: what a browser honours, a hint elsewhere). */
  fetch(url: string, init?: { cache?: RequestCache; priority?: RequestPriority }): Promise<Response>;
  /** The connection asks to save data: nothing fetched ahead. */
  saveData?(): boolean;
}

let current: Platform | undefined;

export function setPlatform(p: Platform): void {
  current = p;
}

export function platform(): Platform {
  if (!current) throw new Error("no platform set (an entry point sets it first)");
  return current;
}

/** A Response of bytes (an asset read from disk, a file kept). */
export function bytesResponse(b: Uint8Array, type = "application/octet-stream"): Response {
  return new Response(b as BlobPart, { headers: { "content-type": type } });
}
