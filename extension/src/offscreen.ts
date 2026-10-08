// The offscreen document: an extension page (cross-origin isolated by the
// manifest, for SharedArrayBuffer once the core is multithreaded) that owns
// the core's worker, and relays each tab's port to it. Binary results go
// back base64: runtime ports carry JSON.

import type { Req, Res } from "./worker.ts";
import { index, resolve } from "./shelf.ts";
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
// (Shelf's index read now, half a second of parsing, while the tab still
// fetches its project: ready by the first package asked)
void index().catch(() => undefined);

const worker = new Worker(new URL("worker.js", import.meta.url), { type: "module" });
/**
 * The two-worker start: at an open, `worker` (A) makes the plain first
 * paint and serves edits as plain rebuilds, while `ssa` (B) builds the SSA
 * program from the start; edits go to A and, queued, to B (edits only, B
 * builds them after its open). When B is ready the tab's session switches
 * to it (a `switched` event: its pages, sync and status from B; pages drawn
 * again only where they differ) and A's session closes. One worker, as
 * before, on a machine with fewer than 4 cores or 4 GB. Shelf packs: both
 * fetch through the browser's HTTP cache (immutable packs; Chrome's cache
 * lets one request for a URL fetch while the others wait for it).
 */
const TWO = navigator.hardwareConcurrency >= 4 && ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) >= 4;
let ssa: Worker | undefined;
/** Per client in the two-worker start: B not ready yet ("plain") or ready ("ssa"), and its open's number (a newer open drops an older B's). */
const dual = new Map<string, { phase: "plain" | "ssa"; open: number }>();
/** The worker a client's requests go to. */
const route = (client: string) => (dual.get(client)?.phase === "ssa" ? ssa! : worker);
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
const fromWorker = (e: MessageEvent<Res & { fetching?: string; name?: string; failed?: boolean; drawPdf?: boolean; client?: string; pdf?: Uint8Array; preparing?: boolean }>) => {
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
worker.onmessage = fromWorker;
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
  // (in the two-worker start's plain phase, to both)
  const post = (r: Req) => {
    route(client).postMessage(r);
    if (dual.get(client)?.phase === "plain") ssa!.postMessage({ ...r, id: nextId++ } as Req);
  };
  const give = (file: string, bytes: Uint8Array) => post({ id: nextId++, client, op: "set_bytes", file, bytes } as Req);
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
      resolve(m.name, m.engine).then(
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
    // (the draw worker draws draw lists; a page from the PDF, dpi -1, is the build worker's)
    if (m.op === "png" && m.dpi >= 0 && drawn.has(client)) return drawer.postMessage({ ...m, id, client } as Req);
    if (m.op === "open") {
      const bins = Object.fromEntries(binaries);
      const was = dual.get(client);
      // (an open after B took over: B goes on alone, as one worker would)
      if (!TWO || m.workers === 1 || was?.phase === "ssa") return route(client).postMessage({ ...m, id, client, binaries: bins } as Req);
      if (was) ssa!.postMessage({ id: nextId++, client, op: "close" } as Req);
      if (!ssa) {
        ssa = new Worker(new URL("worker.js", import.meta.url), { type: "module" });
        ssa.onmessage = fromWorker;
      }
      const open = nextId++;
      dual.set(client, { phase: "plain", open });
      worker.postMessage({ ...m, id, client, binaries: bins, start: 1, noMinted: true } as Req);
      // (B: the SSA program at once; ready when its open answers)
      replies.set(open, (r) => {
        if (dual.get(client)?.open !== open) return;
        if (!r.ok) {
          // (B failed: A builds the program after all)
          dual.delete(client);
          worker.postMessage({ id: nextId++, client, op: "plain_only", on: false } as Req);
          return;
        }
        dual.set(client, { phase: "ssa", open });
        worker.postMessage({ id: nextId++, client, op: "close" } as Req);
        drawn.delete(client);
        try {
          port.postMessage({ event: "switched" });
        } catch {
          /* (the tab went away) */
        }
      });
      ssa.postMessage({ ...m, id: open, client, binaries: bins, start: 2 } as Req);
      return;
    }
    route(client).postMessage({ ...m, id, client } as Req);
    // (B queues what changes the project, as edits only: it builds them after its open)
    if (dual.get(client)?.phase === "plain") {
      if (m.op === "edit") ssa!.postMessage({ ...m, id: nextId++, client, page: -1 } as Req);
      else if (m.op === "set_file") ssa!.postMessage({ ...m, id: nextId++, client } as Req);
    }
  });
  port.onDisconnect.addListener(() => {
    worker.postMessage({ id: nextId++, client, op: "close" });
    ssa?.postMessage({ id: nextId++, client, op: "close" });
    dual.delete(client);
    drawer.postMessage({ id: nextId++, client, op: "close" });
    drawn.delete(client);
  });
});
