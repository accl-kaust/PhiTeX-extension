// Latencies of the wasm core (V8, as in Chrome): open, then edits seen from
// a page (edit_view: first paint, fixed point), plus the status scan and
// the draw list. Run: scripts/sandbox node bench/latency.mjs
import fs from "node:fs";
import { core } from "../test/wasm-harness.mjs";

const para = (i) => `Paragraph ${i} has words enough to take a line or two of the page it is on, and a few more.\n\n`;
const one = (src) => ({ files: { "doc.tex": src }, main: "doc.tex" });
const words = (n) => Array.from({ length: n }, (_, i) => para(i)).join("");
const docs = {
  "small (3 paragraphs)": one("Hello world.\n\n" + para(1) + para(2) + "\\bye\n"),
  "synthetic 200 paragraphs": one(words(200) + "\\bye\n"),
  "synthetic 2000 paragraphs": one(words(2000) + "\\bye\n"),
  // (PhiTeX's a_view test: book.tex's \section, \label, \ref, \pageref: the .aux loop)
  "book.tex + main.tex (refs, .aux loop)": {
    main: "main.tex",
    files: {
      "book.tex": fs.readFileSync(new URL("./book.tex", import.meta.url), "utf8"),
      "main.tex": `\\input book\n\n\\begindocument\n\\section{One}\\label{one}\n\n${words(300)}\\section{Two}See \\ref{one} on page \\pageref{one}.\n\n\\enddocument\n`,
    },
  },
};
const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
const rows = [];
for (const [name, { files, main }] of Object.entries(docs)) {
  const src = files[main];
  const c = await core();
  const t = performance.now();
  const o = c.open(files, main);
  const open = performance.now() - t;
  const enc = new TextEncoder();
  for (const [where, frac, page] of [["start, page 1", 0.05, 0], ["middle, its page", 0.5, -2], ["end, last page", 0.95, -1]]) {
    const pages = c.open.length && o.pages;
    const pg = page === -1 ? Math.max(pages - 1, 0) : page === -2 ? Math.floor(pages / 2) : page;
    const at = enc.encode(src.slice(0, src.indexOf("\n\n", Math.floor(src.length * frac)))).length;
    const paint = [], total = [], call = [], passes = [];
    for (let k = 0; k < 11; k++) {
      const r = c.edit(o.h, main, at, at, "x", pg, 0);
      paint.push(r.paint_ms); total.push(r.total_ms); call.push(r.call_ms); passes.push(r.stats.passes);
      c.edit(o.h, main, at, at + 1, "", pg, 0);
    }
    rows.push({ doc: name, bytes: src.length, pages: o.pages, open_ms: +open.toFixed(1), edit: where, first_paint_ms: +med(paint).toFixed(2), fixed_point_ms: +med(total).toFixed(2), with_draws_ms: +med(call).toFixed(2), passes: med(passes) });
  }
  const st = c.status(o.h);
  rows.push({ doc: name, edit: "status scan (idle, not per edit)", pending: st.pending, fixed_point_ms: +st.ms.toFixed(2) });
  const chk = c.check(o.h);
  rows.push({ doc: name, edit: "debug check (fresh build + compare)", ok: chk.ok, fixed_point_ms: +chk.ms.toFixed(1) });
}
console.table(rows);
fs.writeFileSync(new URL("./latency.json", import.meta.url), JSON.stringify(rows, null, 1));
