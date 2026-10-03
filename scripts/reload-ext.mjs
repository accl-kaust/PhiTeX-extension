// Reload the unpacked extension (dev): chrome.runtime.reload() in its service worker.
const tabs = await (await fetch(`http://localhost:${process.env.PHITEX_CDP_PORT ?? 9222}/json`)).json();
const sw = tabs.find((t) => t.type === "service_worker" && t.url.includes("background.js"));
if (!sw) { console.error("no service worker"); process.exit(1); }
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "chrome.runtime.reload()" } }));
setTimeout(() => process.exit(0), 500);
