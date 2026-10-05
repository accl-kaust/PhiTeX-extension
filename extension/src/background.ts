// The service worker: only makes sure the offscreen document (which runs
// the core's worker) exists. Content scripts then connect to it directly.

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  // (Firefox: no offscreen documents; the background page is the core's
  // page itself, firefox-bg.html, always there)
  if (!chrome.offscreen) return;
  const url = chrome.runtime.getURL("offscreen.html");
  const have = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType], documentUrls: [url] });
  if (have.length) return;
  creating ??= chrome.offscreen
    .createDocument({ url, reasons: ["WORKERS" as chrome.offscreen.Reason], justification: "Runs the PhiTeX typesetter (wasm) in a worker, locally." })
    .finally(() => (creating = null));
  await creating;
}

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  // (Shelf asks for a newer extension: the store's update, checked now)
  if (m?.type === "update-check") {
    void chrome.runtime.requestUpdateCheck?.().catch(() => undefined);
    return;
  }
  if (m?.type === "ensure-offscreen") {
    ensureOffscreen().then(() => reply(true), (e) => reply(String(e)));
    return true;
  }
});

// What's new: after an update, the notes the user hasn't seen show once in
// Overleaf; a fresh install sees the welcome tip instead, so its notes count
// as seen.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  const version = chrome.runtime.getManifest().version;
  if (reason === "install") void chrome.storage.local.set({ newsSeen: version });
});
