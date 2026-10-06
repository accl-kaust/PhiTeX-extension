// The offscreen document: an extension page (cross-origin isolated by the
// manifest, for SharedArrayBuffer once the core is multithreaded) that owns
// the core's worker, and relays each tab's port to it. Binary results go
// back base64: runtime ports carry JSON.

import type { Req, Res } from "./worker.ts";
import { resolve } from "./shelf.ts";
import { refresh, type Release } from "./release.ts";

/** Shelf's release as last read (release.ts): each tab is told on connecting. */
let release: Release | undefined;
const told = (r: Release | undefined) => {
  release = r;
  for (const p of ports) p.postMessage({ event: "release", release: r });
};
// (at most once a day; a newer index is used by the next worker)
void refresh().then(told, () => undefined);
setInterval(() => void refresh().then(told, () => undefined), 3600 * 1000);

const worker = new Worker(new URL("worker.js", import.meta.url), { type: "module" });
/**
 * The draw worker: a second core instance that only draws pages, from the
 * PDF the build worker links. Pages draw while a build (or readying the
 * next one) runs; the page read first, then the rest ahead of time.
 */
const drawer = new Worker(new URL("worker.js", import.meta.url), { type: "module", name: "draw" });
/** The clients whose drawer has their current PDF: their pages are asked there. */
const drawn = new Set<string>();
const replies = new Map<number, (r: Res) => void>();
let nextId = 1;
/** Every tab's port: the worker's progress (a Shelf pack fetched mid-build) goes to each. */
const ports = new Set<chrome.runtime.Port>();
worker.onmessage = (e: MessageEvent<Res & { fetching?: string; name?: string; failed?: boolean; drawPdf?: boolean; client?: string; pdf?: Uint8Array; preparing?: boolean }>) => {
  if (e.data.fetching) {
    for (const p of ports) p.postMessage({ event: "fetching", pack: e.data.fetching, name: e.data.name, failed: e.data.failed });
    return;
  }
  if (e.data.drawPdf && e.data.client && e.data.pdf) {
    drawer.postMessage({ id: nextId++, client: e.data.client, op: "drawpdf", pdf: e.data.pdf } as Req, [e.data.pdf.buffer]);
    drawn.add(e.data.client);
    return;
  }
  if ((e.data as { settled?: boolean }).settled) {
    for (const p of ports) p.postMessage({ event: "settled" });
    return;
  }
  if (e.data.preparing !== undefined) {
    for (const p of ports) p.postMessage({ event: "preparing", on: e.data.preparing });
    return;
  }
  replies.get(e.data.id)?.(e.data);
  replies.delete(e.data.id);
};
drawer.onmessage = (e: MessageEvent<Res>) => {
  replies.get(e.data.id)?.(e.data);
  replies.delete(e.data.id);
};

function b64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "phitex") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  if (release) port.postMessage({ event: "release", release });
  const client = `tab${port.sender?.tab?.id}:${port.sender?.frameId ?? 0}:${Math.random()}`;
  // (binary files, font metrics: given to this client's core session here,
  // since the port carries JSON; again after each open, a new session)
  const binaries = new Map<string, Uint8Array>();
  const give = (file: string, bytes: Uint8Array) => worker.postMessage({ id: nextId++, client, op: "set_bytes", file, bytes } as Req);
  port.onMessage.addListener((m) => {
    // (the project's binary files, figures: kept, given now and after each open)
    if (m.op === "binary") {
      const bytes = Uint8Array.from(atob(m.b64), (c) => c.charCodeAt(0));
      binaries.set(m.file, bytes);
      give(m.file, bytes);
      port.postMessage({ id: m.id, ok: true });
      return;
    }
    // (packages: answered here, not by the worker)
    if (m.op === "package") {
      resolve(m.name).then(
        (r) => {
          // (the rest of its packs: straight to the core, as bytes)
          for (const [f, b] of r?.extra ?? []) {
            binaries.set(f, b);
            give(f, b);
          }
          if (r?.inCore) {
            port.postMessage({ id: m.id, ok: true, text: null, delivered: true, from: r.from });
            return;
          }
          if (r?.bytes) {
            binaries.set(m.name, r.bytes);
            give(m.name, r.bytes);
            port.postMessage({ id: m.id, ok: true, text: null, delivered: true, from: r.from });
          } else port.postMessage({ id: m.id, ok: true, text: r?.text ?? null, from: r?.from });
        },
        (e) => port.postMessage({ id: m.id, ok: false, error: String(e) }),
      );
      return;
    }
    const id = nextId++;
    replies.set(id, async (r) => {
      const out: any = { ...r, id: m.id };
      // (PDF mode: the tab draws the page from the PDF, sent when it changed)
      if (r.png) out.png = b64(r.png);
      if (r.pdf) out.pdf = b64(r.pdf);
      try {
        port.postMessage(out);
      } catch {
        /* (the tab went away) */
      }
    });
    // (an open carries the binary files given so far, figures and fonts: the first build has them)
    // (a new session: its pages from the build worker until its PDF reaches the drawer)
    if (m.op === "open") drawn.delete(client);
    if (m.op === "png" && drawn.has(client)) return drawer.postMessage({ ...m, id, client } as Req);
    worker.postMessage({ ...m, id, client, ...(m.op === "open" ? { binaries: Object.fromEntries(binaries) } : {}) } as Req);
  });
  port.onDisconnect.addListener(() => {
    worker.postMessage({ id: nextId++, client, op: "close" });
    drawer.postMessage({ id: nextId++, client, op: "close" });
    drawn.delete(client);
  });
});
