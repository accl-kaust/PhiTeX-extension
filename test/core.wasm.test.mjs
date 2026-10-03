// The built core (extension/dist/core.wasm, scripts/build.sh first) under
// node:wasi: the ABI the worker uses, edits in bytes from UTF-16, the
// invariant against a fresh build, PNG/PDF, and pending detection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { core } from "./wasm-harness.mjs";
import { Batch } from "../extension/src/edits.ts";
import { readFileSync } from "node:fs";

// (PhiTeX's plain-TeX core: `scripts/build.sh --phitex`. The default build is
// partex's, tested by core-partex/ and test/partex-session.mjs)
const wasm = new WebAssembly.Module(readFileSync(new URL("../extension/dist/core.wasm", import.meta.url)));
const partex = WebAssembly.Module.exports(wasm).some((e) => e.name === "ph_assets");
const test_ = (name, f) => test(name, { skip: partex && "the built core is partex's" }, f);

const main = "\\font\\rm=cmr10 \\rm\nHéllo wörld 😀, a paragraph.\n\n\\input part\n\n\\bye\n";
const part = "Pärt one.\n\n";

test_("open, edit (UTF-16 → bytes), check, png, pdf", async () => {
  const c = await core();
  const o = c.open({ "main.tex": main, "part.tex": part }, "main.tex");
  assert.equal(o.pages, 1);
  assert.equal(o.pending, 0);
  const b = new Batch(main);
  const at = main.indexOf("wörld") + 5;
  for (const ch of " und 日本 😀") b.push({ from: at + b.text.length - main.length, to: at + b.text.length - main.length, text: ch });
  for (const e of b.take()) assert.equal(c.edit(o.h, "main.tex", e.start, e.end, e.text, 0).ok, 1);
  const v = c.edit(o.h, "part.tex", 0, 5, "Ünïcödé", 0);
  assert.equal(v.ok, 1, JSON.stringify(v));
  assert.ok(v.paint_ms <= v.total_ms);
  assert.deepEqual(c.check(o.h).ok, true);
  assert.equal(c.edit(o.h, "main.tex", 1000, 1001, "x").ok, 0); // (out of range: refused, not a trap)
  const now = b.text; // (main.tex now)
  const inside = new TextEncoder().encode(now.slice(0, now.indexOf("😀"))).length + 1;
  assert.match(c.edit(o.h, "main.tex", inside, inside, "x").error, /boundar/);
  assert.deepEqual([...c.png(o.h, 0).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(new TextDecoder().decode(c.pdf(o.h).slice(0, 5)), "%PDF-");
});

test_("LaTeX: PhiTeX drops its commands without a trace (so the warning is a source heuristic)", async () => {
  const c = await core();
  const o = c.open({ "main.tex": "\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n" }, "main.tex");
  assert.equal(o.pending, 0);
  assert.equal(o.undefined, 0);
  assert.equal(c.status(o.h).pending, 0);
  const { diagnose } = await import("../extension/src/diagnostics.ts");
  assert.equal(diagnose({ "main.tex": "\\documentclass{article}\n" }, "main.tex")[0].code, "latex");
});
