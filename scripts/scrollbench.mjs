// Scroll a dumped ⚡ view (mock-run's {"dumpview": name}) in a bare headless
// Chromium and time the frames, for each variant: a style added, or a script
// run first. Dev/test only.
//   node scripts/scrollbench.mjs FILE.html [variants.json] [ms]
// variants.json: [{ "name": "...", "css": "...", "js": "..." }, ...]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [file, vfile, msArg] = process.argv.slice(2);
const ms = +(msArg ?? 5000);
const variants = vfile ? JSON.parse(fs.readFileSync(vfile, "utf8")) : [{ name: "as dumped" }];
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const port = 9400 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(path.dirname(path.resolve(file)), ".bench-profile-"));

for (const v of variants) {
  const chrome = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=900,1200", `file://${path.resolve(file)}`], { stdio: "ignore", detached: true });
  let tab;
  for (let i = 0; i < 80 && !tab; i++) {
    await sleep(250);
    try { tab = (await (await fetch(`http://localhost:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
  }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); });
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const run = async (expr) => (await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await sleep(1500);
  if (v.css) await run(`(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(v.css)}; document.head.append(s); })()`);
  if (v.js) await run(v.js);
  // (one pass to warm: every page painted once)
  const scroll = (t) => `new Promise((done) => { const st = document.getElementById("stage"); st.scrollTop = 0; const t0 = performance.now(), ts = []; let dir = 1; const f = (t) => { ts.push(t); st.scrollTop += dir * 60; if (st.scrollTop + st.clientHeight >= st.scrollHeight - 1) dir = -1; if (st.scrollTop <= 0) dir = 1; if (t - t0 < ${t}) requestAnimationFrame(f); else done(ts); }; requestAnimationFrame(f); })`;
  await run(scroll(3000));
  await call("Performance.enable");
  const metrics = async () => Object.fromEntries((await call("Performance.getMetrics")).result.metrics.map((m) => [m.name, m.value]));
  const m0 = await metrics();
  const frames = await run(scroll(ms));
  const m1 = await metrics();
  const dt = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
  const q = (p) => dt[Math.min(dt.length - 1, Math.floor(p * dt.length))].toFixed(1);
  const busy = (((m1.TaskDuration - m0.TaskDuration) * 1000) / ms) * 100;
  console.log(`${v.name.padEnd(34)} fps ${((1000 * dt.length) / ms).toFixed(1).padStart(5)}  median ${q(0.5).padStart(5)}  p95 ${q(0.95).padStart(6)}  max ${dt.at(-1).toFixed(1).padStart(6)}  busy ${busy.toFixed(0).padStart(3)}%`);
  ws.close();
  process.kill(-chrome.pid);
  await sleep(500);
}
fs.rmSync(profile, { recursive: true, force: true });
