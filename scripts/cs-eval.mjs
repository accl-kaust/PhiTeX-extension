// Dev: evaluate JS in the extension's content-script world of a tab (it has
// chrome.storage): node scripts/cs-eval.mjs <url-substring> '<expression>'
const [match, expr] = process.argv.slice(2);
const t = (await (await fetch(`http://localhost:${process.env.PHITEX_CDP_PORT ?? 9222}/json`)).json()).find((t) => t.type === "page" && t.url.includes(match));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
const contexts = [];
let id = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.method === "Runtime.executionContextCreated") contexts.push(d.params.context);
  pending.get(d.id)?.(d);
});
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await call("Runtime.enable");
await new Promise((r) => setTimeout(r, 300));
const ctx = contexts.find((c) => c.auxData?.type === "isolated" && c.origin.startsWith("chrome-extension://"));
if (!ctx) { console.error("no content-script world", contexts.map((c) => c.name)); process.exit(1); }
const r = await call("Runtime.evaluate", { expression: expr, contextId: ctx.id, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result?.result?.value ?? r.result));
process.exit(0);
