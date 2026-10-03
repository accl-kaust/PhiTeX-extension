// Dev: the live preview's state as JSON, no screenshot: the session (files,
// main, pages, the package loop) and the core's status (history, missing,
// the last build's kind and time, the terminal's tail).
//   node scripts/state.mjs <url-substring> [--term | --log]
// (--log: the whole terminal of the last build and the job's .log)
import { execFileSync } from "node:child_process";
const [match, flag] = process.argv.slice(2);
const expr = `(async () => {
  const s = globalThis.__phitexSession;
  if (!s) return { error: "no session in this tab" };
  const st = (await s.core.request({ op: "status" })).json ?? {};
  const files = Object.fromEntries(Object.entries(s.files).map(([k, v]) => [k, v.length]));
  return {
    main: s.main, open: s.open, pages: s.pages, files,
    packages: { given: Object.keys(s.pkgFiles).length, asked: s.asked.size, ...s.pkg },
    core: { history: st.history, pages: st.pages, builds: st.builds, build_ms: st.build_ms, how: st.how, missing: st.missing, error: st.error },
    ${flag === "--term" ? "term: st.term," : ""}
    ${flag === "--log" ? 'term: (await s.core.request({ op: "log" })).json?.log ?? "(no log)",' : ""}
  };
})()`;
const out = execFileSync("node", [new URL("cs-eval.mjs", import.meta.url).pathname, match, `${expr}.then(JSON.stringify)`], { encoding: "utf8" });
const v = JSON.parse(JSON.parse(out));
if (v.term) { const t = v.term; delete v.term; console.log(JSON.stringify(v, null, 2)); console.log("--- terminal\n" + t); }
else console.log(JSON.stringify(v, null, 2));
