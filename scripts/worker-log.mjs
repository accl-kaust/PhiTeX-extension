// Dev: start the core's worker in the offscreen document and print what it
// logs or throws (CDP auto-attach), then the reply to one `open`.
const tabs = await (await fetch(`http://localhost:${process.env.PHITEX_CDP_PORT ?? 9222}/json`)).json();
const off = tabs.find((t) => t.url.endsWith("/offscreen.html"));
const ws = new WebSocket(off.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const send = (method, params = {}, sessionId) => ws.send(JSON.stringify({ id: ++id, method, params, sessionId }));
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.method === "Target.attachedToTarget") {
    send("Runtime.enable", {}, d.params.sessionId);
    send("Runtime.runIfWaitingForDebugger", {}, d.params.sessionId);
  }
  if (d.method === "Runtime.exceptionThrown") console.log("EXC", d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  if (d.method === "Runtime.consoleAPICalled") console.log("LOG", d.params.args.map((a) => a.value ?? a.description).join(" "));
  if (d.result?.result?.value) console.log("REPLY", d.result.result.value);
});
send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
send("Runtime.evaluate", {
  awaitPromise: true, returnByValue: true,
  expression: `new Promise(r => { const w = new Worker("dist/worker.js?" + Date.now(), {type: "module"}); w.onerror = e => r("onerror " + e.message); w.onmessage = e => r(JSON.stringify(e.data).slice(0, 400)); w.postMessage({id: 1, client: "t", op: "open", main: "a.tex", files: {"a.tex": "\\\\font\\\\rm=Times-Roman at 10pt \\\\rm Hi.\\n\\n\\\\bye\\n"}, fuel: 100000}); setTimeout(() => r("timeout"), 5000); })`,
});
setTimeout(() => process.exit(0), 6000);
