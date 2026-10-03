// Screenshot a tab (dev): node scripts/shot.mjs <url-substring> <out.png>
import fs from "node:fs";
const [match, file] = process.argv.slice(2);
const t = (await (await fetch(`http://localhost:${process.env.PHITEX_CDP_PORT ?? 9222}/json`)).json()).find((t) => t.type === "page" && t.url.includes(match));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } }));
ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id === 1) { fs.writeFileSync(file, Buffer.from(d.result.data, "base64")); process.exit(0); } });
