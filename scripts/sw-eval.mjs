// Dev: evaluate JS in the extension's service worker (e.g. chrome.storage),
// through the browser's target list (/json does not always list it).
const [expr] = process.argv.slice(2);
const { webSocketDebuggerUrl } = await (await fetch("http://localhost:9222/json/version")).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  pending.get(d.id)?.(d);
});
const call = (method, params = {}, sessionId) =>
  new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
let sw;
for (let i = 0; i < 50 && !sw; i++) {
  const { result } = await call("Target.getTargets");
  sw = result.targetInfos.find((t) => t.type === "service_worker" && t.url.includes("background.js"));
  if (!sw) await new Promise((r) => setTimeout(r, 200));
}
if (!sw) { console.error("no service worker (load an Overleaf tab to wake it)"); process.exit(1); }
const { result: { sessionId } } = await call("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
console.log(JSON.stringify(r.result?.result?.value ?? r.result ?? r.error));
process.exit(0);
