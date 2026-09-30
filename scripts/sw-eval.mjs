// Dev: evaluate JS in the extension's service worker (e.g. chrome.storage.local.clear()).
const [expr] = process.argv.slice(2);
const sw = (await (await fetch("http://localhost:9222/json")).json()).find((t) => t.type === "service_worker" && t.url.includes("background.js"));
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id === 1) { console.log(JSON.stringify(d.result.result?.value ?? d.result)); process.exit(0); } });
