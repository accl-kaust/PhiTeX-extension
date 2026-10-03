// Evaluate JS in a Chromium tab over the DevTools protocol (dev/test only).
//   node scripts/cdp.mjs <url-substring> '<js expression>'   (awaits promises)
const [match, expr] = process.argv.slice(2);
const tabs = await (await fetch(`http://localhost:${process.env.PHITEX_CDP_PORT ?? 9222}/json`)).json();
const tab = tabs.find((t) => (t.type === "page" || t.type === "background_page") && t.url.includes(match));
if (!tab) { console.error("no tab matching", match, tabs.map((t) => t.url)); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.id !== 1) return;
  const r = d.result;
  console.log(r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails) : typeof r.result.value === "string" ? r.result.value : JSON.stringify(r.result.value, null, 1));
  ws.close();
});
