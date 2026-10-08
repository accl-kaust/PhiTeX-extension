// The offscreen document: an extension page (cross-origin isolated by the
// manifest, for SharedArrayBuffer once the core is multithreaded) that runs
// the core's host (common/src/corehost.ts: its workers, the packages and
// compares it answers, the draw worker) and relays each tab's port to it.
// Binary files and results cross base64: runtime ports carry JSON.

import "./platform.ts";
import { CoreHost } from "./common/corehost.ts";

const host = new CoreHost({
  spawn: (name) => new Worker(new URL("worker.js", import.meta.url), name ? { type: "module", name } : { type: "module" }),
  // (one worker on a machine with fewer than 4 cores or 4 GB)
  two: navigator.hardwareConcurrency >= 4 && ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) >= 4,
});

function b64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "phitex") return;
  const client = host.connect(`tab${port.sender?.tab?.id}:${port.sender?.frameId ?? 0}:${Math.random()}`, (m) => {
    // (PDF mode: the tab draws the page from the PDF, sent when it changed)
    if (m.png) m.png = b64(m.png);
    if (m.pdf) m.pdf = b64(m.pdf);
    port.postMessage(m);
  });
  // (the project's binary files, figures: as bytes to the host)
  port.onMessage.addListener((m) => client.message(m.op === "binary" ? { ...m, bytes: Uint8Array.from(atob(m.b64), (c) => c.charCodeAt(0)) } : m));
  port.onDisconnect.addListener(() => client.close());
});
