import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../common/src/vendor/viewer/diagnostics.ts";

const codes = (files: Record<string, string>, main = "a.tex", build?: any) => diagnose(files, main, build).map((d) => `${d.code}@${d.line ?? "-"}`);

test("a clean document has none", () => {
  assert.deepEqual(codes({ "a.tex": "Hello {\\bf world}.\n\n% a comment with { in it\n\\{ escaped \\}\n\\bye\n" }), []);
});

test("an open brace, at the line it opened", () => {
  assert.deepEqual(codes({ "a.tex": "One.\n\nTwo {open\n\nThree.\n\\bye\n" }), ["unclosed-brace@3"]);
});

test("stray }, open $, \\def with no body, missing \\input", () => {
  const c = codes({ "a.tex": "A } b.\n\nMath $x+1\n\nmore.\n\n\\def\\foo\n\\input nothere\n\\input b\n\\bye\n", "b.tex": "" });
  assert.deepEqual(c.sort(), ["def-no-body@7", "missing-file@8", "stray-brace@1", "unclosed-math@3"]);
});

test("$...$ and $$...$$ are balanced", () => {
  assert.deepEqual(codes({ "a.tex": "Inline $x$ and display $$y$$.\n\n\\bye\n" }), []);
});

test("LaTeX is an error, first; build facts too", () => {
  const d = diagnose({ "a.tex": "\\documentclass{article}\n\\begin{document}\nHi é\n\\end{document}\n" }, "a.tex", { pages: 0, pending: 2 });
  assert.equal(d[0].code, "latex");
  assert.deepEqual(d.map((x) => x.code).sort(), ["latex", "no-pages", "non-ascii", "pending"]);
});

test("no \\bye is only info", () => {
  assert.deepEqual(diagnose({ "a.tex": "Hi.\n" }, "a.tex").map((d) => [d.code, d.severity]), [["no-end", "info"]]);
});
