// Dev harness: a scenario on the mock Overleaf, traced. Starts the mock with a
// project (folder or Overleaf source ZIP) and Chromium with the extension
// (:9223, .chrome-profile-3), waits for the first page, plays the steps the
// way Overleaf's editor delivers them, and writes what happened:
//   target/mock-run/<name>/trace.txt   every core request and reply, package
//                                      fetches, layouts, console errors, by ms
//   target/mock-run/<name>/<shot>.png  screenshots the steps ask for
// and prints the timeline and a summary (builds, worst build, final status).
//
//   node scripts/mock-run.mjs SCENARIO.json [--fresh] [--keep]
//
// SCENARIO.json:
//   { "project": "path/to/dir-or.zip", "name": "circuitikz",
//     "steps": [
//       { "type": "circuitikz", "after": "\\usepackage{", "last": true, "keys": 150 },  // key by key, 150 ms apart, after the last match
//       { "type": "\\usepackage{}\n", "before": "\\begin{document}" },      // one edit (a paste)
//       { "replace": "Intro", "with": "Introduction" },
//       { "idle": 1500 },            // until nothing happens for 1.5 s (and no package in flight)
//       { "wait": 2000 },
//       { "shot": "after-package" },
//       { "clean": true },           // ⟳ Clean recompile
//       { "recompile": true }        // Overleaf's Recompile (the local pdflatex)
//     ] }
// --fresh: the package cache (IndexedDB) emptied first, as a new install.
// --keep: Chromium and the mock left running after.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const sc = JSON.parse(fs.readFileSync(args.find((a) => !a.startsWith("--")), "utf8"));
const fresh = args.includes("--fresh"), keep = args.includes("--keep");
const PORT = 9223, PROFILE = ".chrome-profile-3";
const out = path.join(root, "target/mock-run", sc.name ?? "run");
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the mock, on the scenario's project
try { execFileSync("pkill", ["-f", "^node mock/server.mjs"]); } catch {}
await sleep(500);
const mock = spawn("node", ["mock/server.mjs"], { cwd: root, env: { ...process.env, MOCK_PROJECT: path.resolve(sc.project) }, stdio: ["ignore", "pipe", "inherit"], detached: true });
await new Promise((r) => mock.stdout.once("data", r));
// Chromium with the extension
if (fresh) fs.rmSync(path.join(root, PROFILE, "Default/IndexedDB"), { recursive: true, force: true });
execFileSync("bash", ["scripts/chrome.sh"], { cwd: root, env: { ...process.env, PHITEX_CDP_PORT: String(PORT), PHITEX_PROFILE: PROFILE } });

// the tab, over the DevTools protocol: page world (the editor) and the content script's
let tab;
for (let i = 0; i < 60 && !tab; i++) {
  await sleep(250);
  try { tab = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.type === "page" && t.url.includes("project/mock")); } catch {}
}
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map(), contexts = [], events = [];
const T0 = Date.now();
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.method === "Runtime.executionContextCreated") contexts.push(d.params.context);
  if (d.method === "Runtime.executionContextsCleared") contexts.length = 0;
  if (d.method === "Runtime.exceptionThrown") events.push({ t: Date.now() - T0, k: "EXCEPTION", d: d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text });
  if (d.method === "Runtime.consoleAPICalled" && /error|warn/.test(d.params.type)) events.push({ t: Date.now() - T0, k: `console.${d.params.type}`, d: d.params.args.map((a) => a.value ?? a.description).join(" ") });
  pending.get(d.id)?.(d);
});
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await call("Runtime.enable");
const evalIn = async (expr, cs = false) => {
  const ctx = cs ? contexts.find((c) => c.auxData?.type === "isolated" && c.origin.startsWith("chrome-extension://")) : contexts.find((c) => c.auxData?.isDefault);
  if (!ctx) return undefined;
  const r = await call("Runtime.evaluate", { expression: expr, contextId: ctx.id, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};
const state = () => evalIn(`(() => { const s = globalThis.__phitexSession; if (!s) return null; return { n: s.trace.length, last: s.trace.at(-1)?.t ?? 0, now: Math.round(performance.now()), loading: s.pkg.loading.length, building: s.pkg.building, inflight: s.inflight, pages: s.pages } })()`, true);
/** Until nothing new for `quiet` ms and no package in flight (or `max`). */
async function idle(quiet = 1500, max = 180_000) {
  const t = Date.now();
  let n = -1, since = Date.now();
  while (Date.now() - t < max) {
    const s = await state();
    if (s && s.n !== n) (n = s.n, since = Date.now());
    if (s && Date.now() - since >= quiet && !s.loading && !s.building && !s.inflight) return true;
    await sleep(200);
  }
  return false;
}
const shot = async (name) => {
  const r = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, "base64"));
};
const pos = (s) => `(() => { const t = mockEditor.text(); ${s.after !== undefined ? `const i = t.${s.last ? "lastIndexOf" : "indexOf"}(${JSON.stringify(s.after)}); return i < 0 ? -1 : i + ${JSON.stringify(s.after)}.length;` : s.before !== undefined ? `return t.indexOf(${JSON.stringify(s.before)});` : "return t.length;"} })()`;

// the first page
for (let i = 0; i < 100 && !(await state())?.pages; i++) await sleep(300);
await idle();
const steps = [];
for (const s of sc.steps ?? []) {
  const t = Date.now() - T0;
  if (s.type !== undefined) {
    const at = await evalIn(pos(s));
    if (at < 0) throw new Error(`step: anchor not found: ${JSON.stringify(s)}`);
    if (s.keys) {
      // (key by key, as typing: each its own transaction)
      await evalIn(`(async () => { let at = ${at}; for (const c of ${JSON.stringify(s.type)}) { mockEditor.type(at, c); at += c.length; await new Promise((r) => setTimeout(r, ${s.keys})); } })()`);
    } else await evalIn(`mockEditor.type(${at}, ${JSON.stringify(s.type)})`);
  } else if (s.replace !== undefined) {
    await evalIn(`(() => { const t = mockEditor.text(), i = t.indexOf(${JSON.stringify(s.replace)}); if (i >= 0) mockEditor.replace(i, i + ${JSON.stringify(s.replace)}.length, ${JSON.stringify(s.with ?? "")}); })()`);
  } else if (s.idle !== undefined) await idle(s.idle);
  else if (s.wait !== undefined) await sleep(s.wait);
  else if (s.shot) await shot(s.shot);
  else if (s.clean) await evalIn(`(() => { document.getElementById("phitex-zoom")?.click(); document.querySelector("[data-act=clean]")?.click(); })()`);
  else if (s.recompile) await evalIn(`document.getElementById("recompile").click()`);
  steps.push({ t, k: "STEP", d: s });
}
await idle();
await shot("final");

// the trace: the session's, the steps, and the page's errors, by time
const sess = await evalIn(`(async () => { const s = globalThis.__phitexSession; const st = (await s.core.request({ op: "status" })).json; return { trace: s.trace, t0: Math.round(performance.timeOrigin), status: { pages: st.pages, history: st.history, error: st.error?.message, missing: st.missing }, pkg: s.pkg } })()`, true);
const fmt = (d) => (d === undefined ? "" : typeof d === "string" ? d : JSON.stringify(d));
// (the session's times count from its first event; the steps' from this script's start: both shown, apart)
const lines = [
  ...sess.trace.map((e) => `${String(e.t).padStart(7)} ms  ${e.k.padEnd(18)} ${fmt(e.d)}`),
  "",
  "steps and page errors (ms since this script started):",
  ...[...steps, ...events].sort((a, b) => a.t - b.t).map((e) => `${String(e.t).padStart(7)} ms  ${e.k.padEnd(18)} ${fmt(e.d)}`),
];
fs.writeFileSync(path.join(out, "trace.txt"), lines.join("\n") + "\n");
fs.writeFileSync(path.join(out, "trace.json"), JSON.stringify({ steps, events, ...sess }, null, 1));
const builds = sess.trace.filter((e) => e.k.startsWith("←") && e.d?.build_ms !== undefined);
const worst = builds.reduce((a, b) => (b.d.build_ms > (a?.d.build_ms ?? -1) ? b : a), undefined);
console.log(lines.slice(0, 400).join("\n"));
console.log(`\n${sc.name ?? "run"}: ${builds.length} builds, worst ${worst?.d.build_ms ?? 0} ms (${worst?.k ?? "-"} at ${worst?.t ?? 0} ms); final: ${fmt(sess.status)}; packages: ${sess.pkg.done?.length ?? 0} fetched, ${sess.pkg.failed?.length ?? 0} failed`);
console.log(`trace and screenshots: ${out}`);
ws.close();
if (!keep) {
  try { execFileSync("pkill", ["-f", "--", `--user-data-dir=${path.join(root, PROFILE)}( |$)`]); } catch {}
  process.kill(-mock.pid);
}
process.exit(0);
