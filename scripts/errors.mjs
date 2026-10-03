// Dev: reload a tab and print exceptions and console errors from every
// context in it (the content script's isolated world too), for 6 s.
const [match] = process.argv.slice(2);
const t = (await (await fetch(`http://localhost:${process.env.PHITEX_CDP_PORT ?? 9222}/json`)).json()).find((t) => t.type === "page" && t.url.includes(match));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.method === "Runtime.exceptionThrown") console.log("EXC", d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text, d.params.exceptionDetails.url ?? "");
  if (d.method === "Runtime.consoleAPICalled" && /error|warn/.test(d.params.type)) console.log(d.params.type.toUpperCase(), d.params.args.map((a) => a.value ?? a.description).join(" "));
  if (d.method === "Log.entryAdded" && d.params.entry.level === "error") console.log("LOG", d.params.entry.text, d.params.entry.url ?? "");
});
ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
ws.send(JSON.stringify({ id: 2, method: "Log.enable" }));
ws.send(JSON.stringify({ id: 3, method: "Page.reload" }));
setTimeout(() => process.exit(0), 6000);
