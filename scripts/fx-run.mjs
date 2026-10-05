// The extension in Firefox, on the local mock, for debugging the Firefox
// build: installs it as a temporary add-on over WebDriver BiDi, writes the
// onboarded state (scripts/onboarded.mjs: no clicking through the terms or
// the tour), opens the mock project, waits for the ⚡ pages, screenshots.
//
//   scripts/package.sh                      # store/phitex-instant-<v>-firefox.zip
//   scripts/fx-run.mjs [--wait 30] [--url http://localhost:8123/project/mock] [--shot out.png]
//
// Needs: Firefox (128+) on PATH, the mock running
// (scripts/sandbox --net node mock/server.mjs). The add-on is the Firefox
// package, unzipped into target/fx-dev/ with the mock's address added to
// its matches (the store package matches overleaf.com only). Firefox runs
// with its own profile in target/fx-profile/ and stays open after
// (--close to quit it), so a second run reuses it.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { onboardScript, traceScript } from "./onboarded.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const url = opt("--url", "http://localhost:8123/project/mock");
const wait = +opt("--wait", "30") * 1000;
const shot = opt("--shot", path.join(root, "target/fx-run.png"));
const PORT = 9224;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the Firefox package, with the mock's address
const version = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"))).version;
const zip = path.join(root, `store/phitex-instant-${version}-firefox.zip`);
if (!fs.existsSync(zip)) throw new Error(`${zip}: run scripts/package.sh first`);
const dev = path.join(root, "target/fx-dev");
fs.rmSync(dev, { recursive: true, force: true });
fs.mkdirSync(dev, { recursive: true });
execFileSync("unzip", ["-q", zip, "-d", dev]);
const m = JSON.parse(fs.readFileSync(path.join(dev, "manifest.json")));
for (const c of m.content_scripts) c.matches.push("http://localhost/project/*");
m.web_accessible_resources[0].matches.push("http://localhost/*");
fs.writeFileSync(path.join(dev, "manifest.json"), JSON.stringify(m, null, 1));

// Firefox with remote debugging (BiDi), started unless already listening
const up = async () => fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false);
if (!(await up())) {
  const profile = path.join(root, "target/fx-profile");
  fs.mkdirSync(profile, { recursive: true });

  spawn("firefox", ["--profile", profile, "--no-remote", "--remote-debugging-port", String(PORT), "about:blank"], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 40 && !(await up()); i++) await sleep(250);
}

console.log(`Firefox on :${PORT}, ${dev}`);
// (Node's WebSocket keeps no handle open: without this the run exits while it waits)
setInterval(() => {}, 1 << 30);
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
let id = 0;
const pend = new Map();
ws.onmessage = (e) => {
  const r = JSON.parse(e.data);
  if (r.id && pend.has(r.id)) (pend.get(r.id)(r), pend.delete(r.id));
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, (r) => (r.type === "error" ? rej(new Error(`${method}: ${r.error}: ${r.message}`)) : res(r.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => j(new Error(`no WebDriver BiDi on :${PORT}`)))));
// (Firefox allows one session; one a crashed run left: its Firefox quit, run again)
const logs = [];
ws.addEventListener("message", (e) => {
  const d = JSON.parse(e.data);
  if (d.method === "log.entryAdded" && /error|warn/.test(d.params.level)) logs.push(`${d.params.level}: ${d.params.text}`.slice(0, 400));
});
await send("session.new", { capabilities: {} }).catch((e) => {
  if (/Maximum number of active sessions/.test(e.message)) {
    try { execFileSync("pkill", ["-f", "target/fx-profile"]); } catch {}
    console.error("fx-run: a stale session held Firefox; it was quit: run again");
    process.exit(2);
  }
  throw e;
});
try {
  await send("session.subscribe", { events: ["log.entryAdded"] });
  const { extension } = await send("webExtension.install", { extensionData: { type: "path", path: dev } });
  const ctx = (await send("browsingContext.getTree", {})).contexts[0].context;
  const ev = async (expression) => (await send("script.evaluate", { expression, target: { context: ctx }, awaitPromise: true })).result?.value;

  // the onboarded state (scripts/onboarded.mjs), then the project again
  await send("browsingContext.navigate", { context: ctx, url, wait: "complete" });
  await sleep(1500);
  console.log("storage:", await ev(onboardScript(version)));
  await send("browsingContext.reload", { context: ctx, wait: "complete" });
  const t0 = Date.now();
  let pages = "";
  while (Date.now() - t0 < wait) {
    await sleep(1000);
    pages = await ev(`(() => { const r = document.querySelector('phitex-preview')?.shadowRoot; return r ? r.querySelectorAll('.slot').length + ' pages, ' + r.querySelectorAll('.slot > *:not(.mark)').length + ' drawn' : 'no preview'; })()`);
    if (/^[1-9]\d* pages, [1-9]/.test(pages)) break;
  }
  console.log(`${pages} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // (the panel's diagnostics and the page's console errors: why, when no pages)
  console.log("diagnostics:", await ev(`(() => { const r = document.querySelector('phitex-preview')?.shadowRoot; return r ? [...r.querySelectorAll('.diag')].map((d) => d.innerText.replace(/\\s+/g, ' ').slice(0, 300)).join(' | ') || '(none)' : '-'; })()`));
  for (const l of logs.slice(-15)) console.log("console:", l);
  if (!/^[1-9]/.test(pages)) console.log("content script:", (await ev(traceScript())).slice(0, 4000));
  const s = await send("browsingContext.captureScreenshot", { context: ctx });
  fs.writeFileSync(shot, Buffer.from(s.data, "base64"));
  console.log("screenshot:", shot);
} catch (e) {
  console.error("fx-run:", e.message);
  process.exitCode = 1;
} finally {
  await send("session.end", {}).catch(() => {});
  if (args.includes("--close")) execFileSync("pkill", ["-f", "target/fx-profile"]);
  process.exit(process.exitCode ?? 0);
}
