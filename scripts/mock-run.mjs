// Dev harness: a scenario on the mock Overleaf, traced. Starts the mock with a
// project (folder or Overleaf source ZIP) and Chromium with the extension
// (:9223, .chrome-profile-3), waits for the first page, plays the steps the
// way Overleaf's editor delivers them, and writes what happened:
//   target/mock-run/<name>/trace.txt   every core request and reply, package
//                                      fetches, layouts, console errors, by ms
//   target/mock-run/<name>/<shot>.png  screenshots the steps ask for
//   target/mock-run/<name>/worker-console.txt  the workers' console (a core panic's message)
//   target/mock-run/<name>/core-log.txt  the core's build log (with rebuild traces: a "trace" step)
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
//       { "scroll": 5 },             // the ⚡ view scrolled to page 6
//       { "recompile": true },       // Overleaf's Recompile (the local pdflatex)
//       { "dblpage": [0, 0.3, 0.4] }, // double-click page 0 at 30% across, 40% down: the editor's selection after
//       { "cursor": "Every writer" },  // the cursor put in that text: the word's highlight boxes 150 ms after
//       { "dbltext": "Every writer" }, // double-click the editor at that text: the page's highlight boxes after
//       { "dbloutline": "Section 3" } // double-click that heading in the file outline
//     ] }
// --fresh: the package cache (IndexedDB) emptied first, as a new install.
// --keep: Chromium and the mock left running after.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { onboardScript } from "./onboarded.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const sc = JSON.parse(fs.readFileSync(args.find((a) => !a.startsWith("--")), "utf8"));
const fresh = args.includes("--fresh"), keep = args.includes("--keep");
// (its own mock port, apart from a mock the user has open on 8123)
// (PHITEX_RUN=n: a second run beside the first, on its own ports and profile)
const RUN = +(process.env.PHITEX_RUN ?? 0);
const PORT = 9223 + 10 * RUN, PROFILE = `.chrome-profile-${3 + RUN}`, MOCK = 8133 + RUN;
const out = path.join(root, "target/mock-run", sc.name ?? "run");
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the mock, on the scenario's project
try { execFileSync("pkill", ["-f", `^node mock/server.mjs ${MOCK}`]); } catch {}
await sleep(500);
const mock = spawn("node", ["mock/server.mjs", String(MOCK)], { cwd: root, env: { ...process.env, MOCK_PROJECT: path.resolve(sc.project) }, stdio: ["ignore", "pipe", "inherit"], detached: true });
await new Promise((r) => mock.stdout.once("data", r));
// Chromium with the extension
if (fresh) fs.rmSync(path.join(root, PROFILE, "Default/IndexedDB"), { recursive: true, force: true });
execFileSync("bash", ["scripts/chrome.sh", `http://localhost:${MOCK}/project/mock`], { cwd: root, env: { ...process.env, PHITEX_CDP_PORT: String(PORT), PHITEX_PROFILE: PROFILE, PHITEX_HEADLESS: "1" } });

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
async function idle(quiet = 1500, max = 900_000) {
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

// the workers' console (the core's stderr: a panic's message, before its trap),
// through the offscreen document's target and the workers attached to it
const workerLog = [];
try {
  const off = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.url.endsWith("/offscreen.html"));
  if (off) {
    const ow = new WebSocket(off.webSocketDebuggerUrl);
    await new Promise((r) => ow.addEventListener("open", r));
    let oid = 0;
    const osend = (method, params = {}, sessionId) => ow.send(JSON.stringify({ id: ++oid, method, params, ...(sessionId ? { sessionId } : {}) }));
    ow.addEventListener("message", (m) => {
      const d = JSON.parse(m.data);
      if (d.method === "Target.attachedToTarget") {
        osend("Runtime.enable", {}, d.params.sessionId);
        osend("Runtime.runIfWaitingForDebugger", {}, d.params.sessionId);
      }
      if (d.method === "Runtime.consoleAPICalled") {
        const text = d.params.args.map((a) => a.value ?? a.description).join(" ");
        workerLog.push(`${Date.now() - T0} ms ${d.params.type}: ${text}`);
      }
    });
    osend("Runtime.enable");
    osend("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }
} catch (e) {
  console.log("worker console: not attached:", String(e));
}

// the first page
for (let i = 0; i < 100 && !(await state())?.pages; i++) await sleep(300);
// (none: why, from the page, not after the idle's 15 minutes)
if (!(await state())?.pages) {
  console.log("no first page in 30 s; the session:", JSON.stringify(await state()));
  console.log("editor:", await evalIn(`(() => { const c = document.querySelector(".cm-editor .cm-content"); return c ? "cm-content" + (c.cmView || c.cmTile ? ", with its view" : ", no view") : typeof mockEditor; })()`));
  for (const e of events) console.log(`  ${e.t} ms  ${e.k}  ${String(e.d).slice(0, 400)}`);
  for (const l of workerLog.slice(-20)) console.log("  worker:", l.slice(0, 400));
  try { process.kill(-mock.pid); } catch {}
  process.exit(1);
}
// ("noidle": the steps start at the first page, while the core readies its rebuilds)
if (!sc.noidle) await idle();
const steps = [];
for (const s of sc.steps ?? []) {
  const t = Date.now() - T0;
  if (s.type !== undefined) {
    const at = await evalIn(pos(s));
    if (at < 0) {
      // (the run goes on, so the trace is still written)
      console.log(`step: anchor not found: ${JSON.stringify(s)}`);
      steps.push({ t, k: "STEP FAILED", d: s });
      continue;
    }
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
  else if (s.scroll !== undefined) {
    // (the ⚡ view scrolled to page `scroll`, as a reader would)
    await evalIn(`(() => { const r = document.querySelector("phitex-preview").shadowRoot; const el = r.querySelector('.slot[data-k="${s.scroll}"]'); if (el) r.getElementById("stage").scrollTop = el.offsetTop - 12; })()`, true);
    await call("Page.captureScreenshot", { format: "png" }); // (a frame: the observer sees the scroll)
  } else if (s.recompile) await evalIn(`document.getElementById("recompile").click()`);
  else if (s.eval !== undefined) {
    // (an expression in the content script's world, for debugging)
    s.result = await evalIn(s.eval, !s.page);
    console.log("eval →", JSON.stringify(s.result));
  } else if (s.dblpage) {
    const [k, fx, fy] = s.dblpage;
    await evalIn(`(() => { const root = document.querySelector('phitex-preview')?.shadowRoot ?? document, all = root.querySelectorAll('.slot'); const el = ${k} < 0 ? all[all.length + ${k}] : root.querySelector('.slot[data-k="${k}"]'); if (!el) return; el.scrollIntoView(); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, composed: true, clientX: r.left + r.width * ${fx}, clientY: r.top + r.height * ${fy} })); })()`, true);
    await sleep(800);
    s.result = await evalIn(`(() => { const v = mockEditor.view, m = v.state.selection?.main; return m && { file: document.querySelector('[aria-selected="true"]')?.getAttribute("aria-label"), text: mockEditor.text().slice(Math.min(m.anchor, m.head), Math.max(m.anchor, m.head)), around: mockEditor.text().slice(Math.max(0, m.anchor - 30), m.anchor + 30) }; })()`);
    console.log("dblpage →", JSON.stringify(s.result));
  } else if (s.pagesel !== undefined) {
    // (text selected on page k: its nth text run, as a mouse drag would; the editor's selection after)
    const [k, n] = s.pagesel;
    await evalIn(`(() => { const r = document.querySelector("phitex-preview").shadowRoot; const t = r.querySelectorAll('.slot[data-k="${k}"] text')[${n}]; if (!t) return; const g = document.createRange(); g.selectNodeContents(t); const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(g); r.getElementById("viewer").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true })); })()`, true);
    await sleep(1500);
    s.result = await evalIn(`(() => { const m = mockEditor.view.state.selection?.main; const t = mockEditor.text(); return m && t.slice(Math.min(m.anchor, m.head), Math.max(m.anchor, m.head)); })()`);
    const shown = await evalIn(`(() => { const r = document.querySelector("phitex-preview").shadowRoot; return r.querySelectorAll('.slot[data-k="${k}"] text')[${n}]?.textContent; })()`, true);
    console.log("pagesel →", JSON.stringify({ selectedOnPage: shown?.slice(0, 80), editorSelection: s.result?.slice(0, 120) }));
  } else if (s.select !== undefined) {
    // (the editor's selection over that text: the page's highlight boxes after)
    await evalIn(`(() => { const t = mockEditor.text(), i = t.indexOf(${JSON.stringify(s.select)}); mockEditor.view.dispatch({ selection: { anchor: i, head: i + ${JSON.stringify(s.select)}.length } }); })()`);
    await sleep(1500);
    s.result = await evalIn(`[...document.querySelector("phitex-preview").shadowRoot.querySelectorAll(".mark.sel")].map((m) => m.parentElement.dataset.k + "@" + m.style.top)`, true);
    console.log("select →", JSON.stringify(s.result));
  } else if (s.auxdump !== undefined) {
    // (the auxiliary files carried in, held and written: into DIR/<name>/{carried,files,written}/)
    const j = await evalIn(`(async () => (await globalThis.__phitexSession.core.request({ op: "auxdump" })).json)()`, true);
    const base = path.resolve(s.auxdump.dir ?? out, s.auxdump.name ?? "dump");
    for (const part of ["carried", "files", "written"]) for (const [n, t] of Object.entries(j?.[part] ?? {})) {
      const f = path.join(base, part, n);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, t);
    }
    console.log(`auxdump → ${base}: carried ${Object.keys(j?.carried ?? {}).length}, files ${Object.keys(j?.files ?? {}).length}, written ${Object.keys(j?.written ?? {}).length}`);
  } else if (s.pdfsave !== undefined) {
    // (the ⚡ PDF as it is now, saved: a fresh build's compared with it)
    const b64 = await evalIn(`(async () => { const b = await globalThis.__phitexSession.pdf(); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`, true);
    const f = path.join(out, `${s.pdfsave}.pdf`);
    fs.writeFileSync(f, Buffer.from(b64 ?? "", "base64"));
    console.log(`pdfsave → ${f}: ${fs.statSync(f).size} bytes`);
  } else if (s.report) {
    // (the debug report, as the user opens it: ⓘ, then "Report a problem…")
    await evalIn(`(() => { const r = document.querySelector("phitex-preview").shadowRoot; r.getElementById("sum").click(); r.querySelector(".reportbtn")?.click(); })()`, true);
    await sleep(500);
    const text = await evalIn(`document.querySelector("phitex-preview").shadowRoot.getElementById("reporttext").value`, true);
    fs.writeFileSync(path.join(out, "report.txt"), text ?? "");
    console.log(`report → ${text?.length ?? 0} chars, ${path.join(out, "report.txt")}`);
  } else if (s.noorigins) {
    // (no glyph-origin requests after layouts: isolates their effect on rebuilds)
    await evalIn(`globalThis.__phitexSession.noOriginsPrefetch = true`, true);
  } else if (s.trace !== undefined) {
    // (the core's rebuilds traced into its log: core-log.txt)
    await evalIn(`globalThis.__phitexSession.core.request({ op: "trace", on: ${!!s.trace} })`, true);
  } else if (s.open !== undefined) {
    await evalIn(`mockEditor.open(${JSON.stringify(s.open)})`);
    await sleep(500);
  } else if (s.dbloutline !== undefined) {
    // (as a user: two clicks, then the double-click)
    await evalIn(`(() => { const b = [...document.querySelectorAll(".outline-item-link")].find((b) => b.textContent === ${JSON.stringify(s.dbloutline)}); b.click(); b.click(); b.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); })()`);
    await sleep(900);
    s.result = await evalIn(`(() => [...document.querySelector("phitex-preview").shadowRoot.querySelectorAll(".mark")].map((m) => [m.parentElement.dataset.k, m.style.top]))()`, true);
    console.log("dbloutline →", JSON.stringify(s.result));
  } else if (s.cursor !== undefined) {
    // (the cursor put inside that text, as a click: the page follows it, no double-click)
    await evalIn(`(() => { const t = mockEditor.text(), i = t.indexOf(${JSON.stringify(s.cursor)}) + 2; mockEditor.select(i); document.querySelector(".cm-content").dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); })()`);
    await sleep(150);
    s.result = await evalIn(`(() => { const ms = [...(document.querySelector('phitex-preview')?.shadowRoot ?? document).querySelectorAll(".mark:not(.sel)")]; return ms.map((m) => [m.parentElement.dataset.k, m.style.left, m.style.top, m.style.width]); })()`, true);
    console.log("cursor →", JSON.stringify(s.result));
  } else if (s.dbltext !== undefined) {
    await evalIn(`(() => { const t = mockEditor.text(), i = t.indexOf(${JSON.stringify(s.dbltext)}); mockEditor.select(i, i + 3); document.querySelector(".cm-content").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); })()`);
    await sleep(700);
    s.result = await evalIn(`(() => { const ms = [...(document.querySelector('phitex-preview')?.shadowRoot ?? document).querySelectorAll(".mark")]; return ms.map((m) => [m.parentElement.dataset.k, m.style.left, m.style.top, m.style.width]); })()`, true);
    console.log("dbltext →", JSON.stringify(s.result));
  }
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
// (the core's own account: each build's how, then the terminal and the job's log)
const log = await evalIn(`(async () => (await globalThis.__phitexSession.core.request({ op: "log" })).json?.log ?? "")()`, true);
fs.writeFileSync(path.join(out, "core-log.txt"), log ?? "");
fs.writeFileSync(path.join(out, "worker-console.txt"), workerLog.join("\n") + "\n");
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
