// The offscreen document: an extension page (cross-origin isolated by the
// manifest, for SharedArrayBuffer once the core is multithreaded) that owns
// the core's worker, and relays each tab's port to it. Binary results go
// back base64: runtime ports carry JSON.

import type { Req, Res } from "./worker.ts";
import { resolve } from "./shelf.ts";

const worker = new Worker(new URL("worker.js", import.meta.url), { type: "module" });
const replies = new Map<number, (r: Res) => void>();
let nextId = 1;
worker.onmessage = (e: MessageEvent<Res>) => {
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
  const client = `tab${port.sender?.tab?.id}:${port.sender?.frameId ?? 0}:${Math.random()}`;
  // (binary files, font metrics: given to this client's core session here,
  // since the port carries JSON; again after each open, a new session)
  const binaries = new Map<string, Uint8Array>();
  const give = (file: string, bytes: Uint8Array) => worker.postMessage({ id: nextId++, client, op: "set_bytes", file, bytes } as Req);
  port.onMessage.addListener((m) => {
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
    worker.postMessage({ ...m, id, client } as Req);
    if (m.op === "open") for (const [f, b] of binaries) give(f, b);
  });
  port.onDisconnect.addListener(() => worker.postMessage({ id: nextId++, client, op: "close" }));
});
