// Type into a tab as a user (dev): real key input through the DevTools
// protocol, one character every `ms`, at the editor's cursor.
//   node scripts/type.mjs <url-substring> <text> [ms]
const [match, text, ms = "40"] = process.argv.slice(2);
const t = (await (await fetch("http://localhost:9222/json")).json()).find((t) => t.type === "page" && t.url.includes(match));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const call = (method, params) => new Promise((r) => { const i = ++id; ws.addEventListener("message", function f(m) { const d = JSON.parse(m.data); if (d.id === i) { ws.removeEventListener("message", f); r(d); } }); ws.send(JSON.stringify({ id: i, method, params })); });
for (const ch of text) {
  await call("Input.insertText", { text: ch });
  await new Promise((r) => setTimeout(r, +ms));
}
process.exit(0);
