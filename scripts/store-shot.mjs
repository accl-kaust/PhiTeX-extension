// Dev: a Chrome Web Store screenshot, exactly 1280×800: the tab's viewport
// emulated at that size, captured, restored.  node scripts/store-shot.mjs <url-substring> <out.png> [ms to settle]
import fs from "node:fs";
const [match, file, settle = "1200"] = process.argv.slice(2);
const t = (await (await fetch(`http://localhost:${process.env.PHITEX_CDP_PORT ?? 9222}/json`)).json()).find((t) => t.type === "page" && t.url.includes(match));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); });
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, +settle));
const shot = await call("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 } });
fs.writeFileSync(file, Buffer.from(shot.result.data, "base64"));
if (!process.env.KEEP) await call("Emulation.clearDeviceMetricsOverride");
process.exit(0);
