// The service worker: only makes sure the offscreen document (which runs
// the core's worker) exists. Content scripts then connect to it directly.

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL("offscreen.html");
  const have = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType], documentUrls: [url] });
  if (have.length) return;
  creating ??= chrome.offscreen
    .createDocument({ url, reasons: ["WORKERS" as chrome.offscreen.Reason], justification: "Runs the PhiTeX typesetter (wasm) in a worker, locally." })
    .finally(() => (creating = null));
  await creating;
}

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.type === "ensure-offscreen") {
    ensureOffscreen().then(() => reply(true), (e) => reply(String(e)));
    return true;
  }
});
