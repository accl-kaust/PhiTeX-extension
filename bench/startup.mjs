// Dev only: where a cold start's time goes. Opens a project on the mock
// Overleaf in headless Chromium with the built extension, and times every
// stage from the navigation to the first painted page, without touching the
// shipped code: the harness wraps browser APIs in the extension's contexts
// over the DevTools protocol before their scripts run (WebAssembly's compile
// and instantiate, the core's exports and imports, fetch/XHR and IndexedDB),
// and records the network of every target (tab, offscreen document, workers).
//
//   node bench/startup.mjs PROJECT_DIR NAME [--slow] [--xelatex] [--phases cold,restart,reload] [--rep N]
//
// Phases, one profile (target/startup/profiles/NAME-{fast,slow}):
//   cold     a fresh profile (no IndexedDB, no HTTP cache), as a new install
//   restart  the browser restarted on that profile: IndexedDB and HTTP cache warm,
//            a new offscreen document and workers (the next day's first open)
//   reload   the tab reloaded in the same browser (offscreen document and its workers alive)
//   installed  a fresh profile left until the packs fetched ahead (prefetch.ts) are in,
//            then the browser restarted and the project opened: the first open after install
// --slow: every target's network emulated at 10 Mbit/s down, 5 up, 80 ms RTT
// (extension resources, chrome-extension://, are local and not throttled).
// --xelatex: the project's engine set to XeLaTeX (else "auto": a fontspec
// project is approximated with pdfLaTeX and stand-ins).
// Writes target/startup/NAME-{fast,slow}/<phase>.json and prints a summary.
// Run it in scripts/sandbox --net (it starts the mock and Chromium itself).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { onboarded } from "../scripts/onboarded.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const argv = process.argv.slice(2);
const [projDir, NAME] = argv.filter((a, i) => !a.startsWith("--") && !["--phases", "--rep"].includes(argv[i - 1]));
const SLOW = argv.includes("--slow"), XE = argv.includes("--xelatex");
const PHASES = (argv.includes("--phases") ? argv[argv.indexOf("--phases") + 1] : "cold,restart,reload").split(",");
const RUN = +(process.env.PHITEX_RUN ?? 0);
const PORT = 9323 + RUN, MOCK = 8233 + RUN;
// (--rep N: a repeat, its own profile and directory, NAME-fast-rN)
const REP = argv.includes("--rep") ? argv[argv.indexOf("--rep") + 1] : "";
const tag = `${NAME}-${SLOW ? "slow" : "fast"}${REP ? "-r" + REP : ""}`;
const profile = path.join(root, "target/startup/profiles", tag);
const out = path.join(root, "target/startup", tag);
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const version = JSON.parse(fs.readFileSync(path.join(root, "overleaf/manifest.json"), "utf8")).version;

// ---- what the harness puts in the extension's contexts (before their scripts) ----
const WORKER_PATCH = `(() => {
  const M = (self.__phx = { marks: [], net: [] }), now = () => performance.now(), W = WebAssembly;
  const cs = W.compileStreaming;
  W.compileStreaming = async function (src) { const t = now(); const m = await cs.call(W, src); M.marks.push({ k: "compile", t0: t, t1: now() }); return m; };
  const inst = W.instantiate;
  W.instantiate = async function (mod, imports) {
    if (imports && imports.phitex) {
      const p = { ...imports.phitex };
      for (const k of ["fetch", "resolve"]) if (p[k]) { const f = p[k]; p[k] = function (...a) { const t = now(); const r = f.apply(this, a); M.marks.push({ k: "import." + k, t0: t, t1: now(), n: r }); return r; }; }
      imports = { ...imports, phitex: p };
    }
    const t = now(); const r = await inst.call(W, mod, imports); M.marks.push({ k: "instantiate", t0: t, t1: now() });
    if (!(r instanceof W.Instance)) return r;
    const ex = {};
    for (const [k, v] of Object.entries(r.exports))
      ex[k] = typeof v === "function" && /^(ph_(assets|open|edit|png|pdf|idle|status|draw_set|draw_page|set_bytes|set_file)|_initialize)$/.test(k)
        ? function (...a) { const t = now(); try { return v.apply(this, a); } finally { M.marks.push({ k, t0: t, t1: now(), n: a[1] }); } } : v;
    return { exports: ex };
  };
  const f0 = self.fetch;
  self.fetch = function (u, o) { const t = now(), url = String(u && u.url || u); return f0.call(this, u, o).then((r) => { M.net.push({ url, t0: t, th: now(), status: r.status }); return r; }); };
  const ab = Response.prototype.arrayBuffer, tx = Response.prototype.text;
  Response.prototype.arrayBuffer = async function () { const t = now(); const b = await ab.call(this); M.marks.push({ k: "body", t0: t, t1: now(), n: b.byteLength, url: this.url }); return b; };
  Response.prototype.text = async function () { const t = now(); const b = await tx.call(this); M.marks.push({ k: "text", t0: t, t1: now(), n: b.length, url: this.url }); return b; };
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...a) { this.__u = String(u); return xo.call(this, m, u, ...a); };
  XMLHttpRequest.prototype.send = function (...a) { const t = now(); try { return xs.apply(this, a); } finally { M.net.push({ url: this.__u, t0: t, t1: now(), sync: true, status: this.status, n: this.response && this.response.byteLength }); } };
  M.name = self.name || "";
})()`;
const OFFSCREEN_PATCH = `(() => {
  const M = (globalThis.__phx = { idb: { get: 0, hit: 0, hitBytes: 0, put: 0, putBytes: 0, getMs: [] }, fetch: [] }), now = () => performance.now();
  const g = IDBObjectStore.prototype.get, p = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.get = function (...a) { const t = now(); const r = g.apply(this, a); M.idb.get++; r.addEventListener("success", () => { if (r.result) { M.idb.hit++; M.idb.hitBytes += r.result.byteLength || 0; } M.idb.getMs.push(now() - t); }); return r; };
  IDBObjectStore.prototype.put = function (v, ...a) { M.idb.put++; M.idb.putBytes += (v && v.byteLength) || 0; return p.call(this, v, ...a); };
  const f0 = globalThis.fetch;
  globalThis.fetch = function (u, o) { const t = now(), url = String(u && u.url || u); return f0.call(this, u, o).then((r) => { M.fetch.push({ url, t0: t, th: now(), status: r.status }); return r; }); };
})()`;
const PAGE_PATCH = `(() => {
  const t = (window.__phStartup = {});
  const tick = () => {
    const h = document.querySelector("phitex-preview"), r = h && h.shadowRoot;
    if (h && !t.host) t.host = performance.now();
    if (r && !t.paint && r.querySelector(".slot svg.page, .slot canvas, .slot img")) t.paint = performance.now();
    if (!t.paint) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

// ---- the browser, over CDP ----
let ws, nextId = 0;
const pending = new Map(), sessions = new Map(), net = new Map();
const call = (method, params = {}, sessionId) =>
  new Promise((r) => {
    const id = ++nextId;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const COND = { offline: false, latency: 80, downloadThroughput: (10e6 / 8), uploadThroughput: (5e6 / 8) };

async function attach(sessionId, info) {
  const s = { id: sessionId, targetId: info.targetId, type: info.type, url: info.url, t: Date.now(), contexts: [] };
  sessions.set(sessionId, s);
  const isExt = info.url.startsWith("chrome-extension://");
  await call("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sessionId);
  if (SLOW) await call("Network.emulateNetworkConditions", COND, sessionId);
  await call("Runtime.enable", {}, sessionId);
  if (info.type === "worker" && isExt) await call("Runtime.evaluate", { expression: WORKER_PATCH }, sessionId);
  if (info.type !== "worker" && info.type !== "service_worker") {
    await call("Page.enable", {}, sessionId);
    const src = info.type === "other" || info.url.endsWith("/offscreen.html") ? OFFSCREEN_PATCH : PAGE_PATCH;
    const a = await call("Page.addScriptToEvaluateOnNewDocument", { source: src }, sessionId);
    if (a.error) console.log("addScript", info.type, info.url, JSON.stringify(a.error));
    if (process.env.PHITEX_STARTUP_DEBUG) console.log("attached", info.type, info.url);
  }
  await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  await call("Runtime.runIfWaitingForDebugger", {}, sessionId);
  s.ready = true;
}

function onMessage(m) {
  const d = JSON.parse(m.data);
  if (d.id) return pending.get(d.id)?.(d), pending.delete(d.id);
  const sid = d.sessionId;
  switch (d.method) {
    case "Target.attachedToTarget":
      void attach(d.params.sessionId, d.params.targetInfo);
      break;
    case "Target.targetInfoChanged": {
      for (const s of sessions.values()) if (s.targetId === d.params.targetInfo.targetId) s.url = d.params.targetInfo.url;
      break;
    }
    case "Runtime.executionContextCreated":
      sessions.get(sid)?.contexts.push(d.params.context);
      break;
    case "Network.requestWillBeSent": {
      const k = `${sid}:${d.params.requestId}`;
      net.set(k, { sess: sessions.get(sid)?.type + " " + (sessions.get(sid)?.url ?? "").replace(/^.*\//, ""), url: d.params.request.url, wall: d.params.wallTime * 1000, ts: d.params.timestamp, type: d.params.type });
      break;
    }
    case "Network.responseReceived": {
      const r = net.get(`${sid}:${d.params.requestId}`);
      if (r) Object.assign(r, { status: d.params.response.status, disk: !!d.params.response.fromDiskCache, mem: !!d.params.response.fromMemoryCache || undefined, tsResp: d.params.timestamp });
      break;
    }
    case "Network.requestServedFromCache": {
      const r = net.get(`${sid}:${d.params.requestId}`);
      if (r) r.mem = true;
      break;
    }
    case "Network.loadingFinished": {
      const r = net.get(`${sid}:${d.params.requestId}`);
      if (r) Object.assign(r, { bytes: d.params.encodedDataLength, tsEnd: d.params.timestamp });
      break;
    }
    case "Network.loadingFailed": {
      const r = net.get(`${sid}:${d.params.requestId}`);
      if (r) Object.assign(r, { failed: d.params.errorText, tsEnd: d.params.timestamp });
      break;
    }
  }
}

let chrome, mock;
async function launch() {
  chrome = spawn("chromium", ["--headless=new", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${path.join(root, "overleaf")}`, "about:blank"], { stdio: "ignore", detached: true });
  let v;
  for (let i = 0; i < 80 && !v; i++) {
    await sleep(150);
    try { v = await (await fetch(`http://localhost:${PORT}/json/version`)).json(); } catch {}
  }
  ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", onMessage);
  sessions.clear();
  await call("Target.setDiscoverTargets", { discover: true });
  await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // (the extension's service worker: the onboarded storage written there)
  let sw;
  for (let i = 0; i < 60 && !sw; i++) {
    await sleep(100);
    sw = [...sessions.values()].find((s) => s.ready && s.type === "service_worker" && s.url.startsWith("chrome-extension://"));
  }
  if (!sw) throw new Error("no extension service worker");
  const store = { ...onboarded(version), workers: 2, ...(XE ? { engine: "xelatex" } : {}) };
  await sleep(300);
  const r = await call("Runtime.evaluate", { expression: `chrome.storage.local.set(${JSON.stringify(store)}).then(() => "ok")`, awaitPromise: true, returnByValue: true }, sw.id);
  if (r.result?.result?.value !== "ok") throw new Error("storage: " + JSON.stringify(r));
}
async function quit() {
  try { await call("Browser.close"); } catch {}
  await sleep(1000);
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
  await sleep(500);
}
const evalIn = async (sid, expr, pick = (c) => c.auxData?.isDefault) => {
  const s = sessions.get(sid);
  const ctx = s?.contexts.filter(pick).at(-1);
  const r = await call("Runtime.evaluate", { expression: expr, ...(ctx ? { contextId: ctx.id } : {}), awaitPromise: true, returnByValue: true }, sid);
  return r.result?.result?.value;
};

async function measure(phase) {
  net.clear();
  const tab = [...sessions.values()].find((s) => s.type === "page" && !s.url.startsWith("chrome-extension://"));
  // (a reload: the offscreen document's counters from the phase before, zeroed)
  for (const s of sessions.values()) if (s.type === "other") await evalIn(s.id, `globalThis.__phx && (globalThis.__phx.idb = { get: 0, hit: 0, hitBytes: 0, put: 0, putBytes: 0, getMs: [] }, globalThis.__phx.fetch = [], 1)`);
  const T0 = Date.now();
  if (phase === "reload") await call("Page.reload", { ignoreCache: false }, tab.id);
  else await call("Page.navigate", { url: `http://localhost:${MOCK}/project/mock` }, tab.id);
  const cs = (c) => c.auxData?.type === "isolated" && c.origin.startsWith("chrome-extension://");
  let st, paintAt;
  for (let i = 0; i < 3000; i++) {
    await sleep(50);
    const p = await evalIn(tab.id, `JSON.stringify(window.__phStartup || null)`);
    const t = p && JSON.parse(p);
    if (t?.paint) { paintAt = t; break; }
    if (i > 2400) break;
  }
  // (then quiet: the packages the build asked for, the SSA worker's start)
  let n = -1, since = Date.now();
  for (let i = 0; i < 600; i++) {
    st = await evalIn(tab.id, `(() => { const s = globalThis.__phitexSession; return s ? { n: s.trace.length, loading: s.pkg.loading.length, building: s.pkg.building, inflight: s.inflight, pages: s.pages } : null })()`, cs);
    if (st && st.n !== n) (n = st.n, since = Date.now());
    if (st && Date.now() - since > 3000 && !st.loading && !st.inflight) break;
    await sleep(200);
  }
  const csData = await evalIn(tab.id, `(() => { const s = globalThis.__phitexSession; return JSON.stringify({ origin: performance.timeOrigin, t0: s && s.t0, trace: s ? s.trace : [], pkg: s && s.pkg }) })()`, cs);
  const pageO = await evalIn(tab.id, `performance.timeOrigin`);
  const marks = await evalIn(tab.id, `new Promise((ok) => { addEventListener("message", (e) => e.data?.src === "phitex-dev" && e.data.type === "traced" && ok(e.data.trace)); postMessage({ src: "phitex-dev", type: "trace" }, location.origin); setTimeout(() => ok("{}"), 3000); })`);
  const workers = [];
  for (const s of sessions.values()) {
    if (s.type !== "worker" || !s.url.startsWith("chrome-extension://")) continue;
    const w = await evalIn(s.id, `JSON.stringify({ origin: performance.timeOrigin, phx: self.__phx || null, name: self.name })`);
    if (w) workers.push({ attached: s.t - T0, ...JSON.parse(w) });
  }
  const off = [...sessions.values()].find((s) => s.url.endsWith("/offscreen.html"));
  const offData = off ? await evalIn(off.id, `(async () => JSON.stringify({ origin: performance.timeOrigin, phx: globalThis.__phx || null, idbCount: await new Promise((ok) => { const o = indexedDB.open("phitex-shelf"); o.onsuccess = () => { try { const st = o.result.objectStoreNames.contains("packs") ? "packs" : "files"; const r = o.result.transaction(st).objectStore(st).count(); r.onsuccess = () => ok(r.result); r.onerror = () => ok(-1); } catch { ok(-2); } }; o.onerror = () => ok(-3); }) }))()`) : null;
  const rec = {
    phase, T0, slow: SLOW, xelatex: XE, paint: paintAt ? { host: pageO + paintAt.host - T0, paint: pageO + paintAt.paint - T0 } : null,
    offscreenAttached: off ? off.t - T0 : null,
    page: { origin: pageO, marks: JSON.parse(marks || "{}").errors ?? [] },
    cs: JSON.parse(csData || "{}"), workers, offscreen: offData && JSON.parse(offData),
    net: [...net.values()].map((r) => ({ ...r, start: r.wall - T0, end: r.tsEnd ? r.wall - T0 + (r.tsEnd - r.ts) * 1000 : null, resp: r.tsResp ? r.wall - T0 + (r.tsResp - r.ts) * 1000 : null })),
  };
  fs.writeFileSync(path.join(out, `${phase}.json`), JSON.stringify(rec, null, 1));
  return rec;
}

// ---- run ----
try { execFileSync("pkill", ["-f", `^node mock/server.mjs ${MOCK}`]); } catch {}
mock = spawn("node", ["mock/server.mjs", String(MOCK)], { cwd: root, env: { ...process.env, MOCK_PROJECT: path.resolve(projDir) }, stdio: ["ignore", "pipe", "inherit"], detached: true });
await new Promise((r) => mock.stdout.once("data", r));
fs.rmSync(profile, { recursive: true, force: true });
try {
  for (const phase of PHASES) {
    if (phase === "installed") {
      if (ws) await quit();
      fs.rmSync(profile, { recursive: true, force: true });
      await launch();
      const sw = [...sessions.values()].find((s) => s.type === "service_worker" && s.url.startsWith("chrome-extension://"));
      const t = Date.now();
      let a;
      for (let i = 0; i < 1200; i++) {
        await sleep(500);
        a = await evalIn(sw.id, `chrome.storage.local.get("ahead").then((x) => JSON.stringify(x.ahead ?? null))`).then(JSON.parse, () => null);
        if (a && a.state !== "running") break;
      }
      console.log(`${tag} installed: ahead ${JSON.stringify(a)} after ${Math.round((Date.now() - t) / 1000)} s`);
      await quit();
      await launch();
    } else if (phase !== "reload" || !ws) {
      if (ws) await quit();
      await launch();
    }
    const r = await measure(phase);
    const tr = r.cs.trace ?? [];
    const open = tr.find((e) => e.k === "← open");
    console.log(`${tag} ${phase}: paint ${r.paint ? Math.round(r.paint.paint) : "-"} ms, open build ${open?.d?.build_ms ?? "-"} ms, requests ${r.net.length}`);
  }
} finally {
  await quit();
  try { process.kill(-mock.pid); } catch {}
}
process.exit(0);
