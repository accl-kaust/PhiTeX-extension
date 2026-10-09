// The VS Code extension's core path without VS Code: the core host on Node
// worker threads (core.ts, dist/worker.js), a session on a project folder,
// its sink recording what the webview would be told. Checks the pages come,
// an edit is typeset, and how long the first page took.
//
//   scripts/build-vscode.sh && scripts/sandbox node vscode/dist/smoke.mjs FOLDER [MAIN]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { setPlatform } from "../../common/src/platform.ts";
import { PreviewSession, type EditorHost, type PreviewSink } from "../../common/src/vendor/viewer/session.ts";
import { hostPackages } from "../../common/src/vendor/viewer/packages.ts";
import { resolve } from "../../common/src/vendor/viewer/engines.ts";
import type { Edit } from "../../common/src/vendor/viewer/edits.ts";
import { findMain } from "../src/changes.ts";
import { HostTransport, startCore } from "../src/core.ts";
import { nodePlatform } from "../src/platform.ts";

const [folder, mainArg] = process.argv.slice(2);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = mkdtempSync(join(tmpdir(), "phitex-store-"));
setPlatform(nodePlatform(root, store));

const files: Record<string, string> = {};
const binaries: Record<string, Uint8Array> = {};
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(png|jpe?g|pdf|eps)$/i.test(n)) binaries[relative(folder, p)] = new Uint8Array(readFileSync(p));
    else if (/\.(tex|sty|cls|bib|bst|cfg|def|clo|bbl)$/i.test(n)) files[relative(folder, p)] = readFileSync(p, "utf8");
  }
};
walk(folder);

let changes: ((file: string, edits: Edit[]) => void) | undefined;
const host: EditorHost = {
  loadProject: async () => ({ ...files }),
  mainFile: (f) => mainArg ?? findMain(f),
  onOpen() {},
  onChanges: (cb) => void (changes = cb),
};

const t0 = performance.now();
const told: Record<string, number> = {};
let pages = 0, drawn = 0, first = 0, firstDraw = 0, errors: string[] = [];
const sink = new Proxy({} as PreviewSink, {
  get: (_t, k: string) => (...a: any[]) => {
    told[k] = (told[k] ?? 0) + 1;
    if (k === "layout") {
      pages = a[0].length;
      if (pages && !first) first = performance.now() - t0;
    }
    if (k === "page" && a[0]) {
      drawn++;
      if (!firstDraw) firstDraw = performance.now() - t0;
    }
    if (k === "error") errors.push(String(a[0]));
  },
  has: () => true,
});

const core = startCore(root, store, (s) => console.error("core:", s));
const transport = new HostTransport(core.host);
const session = new PreviewSession(host, transport, sink, {
  engine: (main) => resolve("auto", undefined, main),
  format: "vector",
  packages: hostPackages(transport as never),
});
for (const [file, bytes] of Object.entries(binaries)) await transport.request({ op: "binary", file, bytes });
await session.start();
// (the pages in view drawn: the webview asks for them)
for (let k = 0; k < Math.min(pages, 2); k++) await session.fetch(k);
const opened = performance.now() - t0;
console.log(`opened: ${pages} pages, layout at ${first.toFixed(0)} ms, first page drawn at ${firstDraw.toFixed(0)} ms, start ${opened.toFixed(0)} ms`);

// (an edit, typed as VS Code reports it: a word inserted into the main file's body)
const main = session.main!;
const at = files[main].indexOf("\\begin{document}") + "\\begin{document}".length;
const t1 = performance.now();
drawn = 0;
changes?.(main, [{ from: at, to: at, text: "\nHello from VS Code. " }]);
for (let i = 0; i < 200 && !drawn; i++) await new Promise((r) => setTimeout(r, 25));
console.log(`edit: ${drawn ? `page drawn ${(performance.now() - t1).toFixed(0)} ms after` : "no page drawn in 5 s"}`);
console.log(`sink calls: ${JSON.stringify(told)}`);
if (errors.length) console.log(`errors: ${errors.join(" | ")}`);
const st = await transport.request({ op: "status" });
console.log(`status: ${JSON.stringify({ pages: st.json?.pages, how: st.json?.how, texError: st.json?.texError })}`);
transport.close();
core.host.stop();
core.stop();
process.exit(pages > 0 && drawn > 0 ? 0 : 1);
