// The debug report (report.ts): anonymized before anyone sees it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anonymizer, report } from "../extension/src/report.ts";

const paths = ["Thesis.tex", "chapters/Intro.tex", "References.bib", "figures/plot.png"];

test("project paths, their base names and job names become aliases", () => {
  const a = anonymizer(paths);
  assert.equal(a("! Undefined control sequence in Thesis.tex:12"), "! Undefined control sequence in file1.tex:12");
  assert.equal(a("(chapters/Intro.tex) (Intro.tex)"), "(file2.tex) (file2.tex)");
  assert.equal(a('open {"main":"Thesis.tex"} job Thesis'), 'open {"main":"file1.tex"} job file1');
  // (not inside other words)
  assert.equal(a("ThesisX Thesis_ x"), "ThesisX Thesis_ x");
});

test("quoted labels and home paths go", () => {
  const a = anonymizer(paths);
  assert.equal(a("Reference `sec:my-secret-idea' on page 3 undefined"), "Reference `…' on page 3 undefined");
  assert.equal(a("panicked at /home/someone/.rustup/x.rs:7"), "panicked at ~/.rustup/x.rs:7");
});

test("the report holds no document text or typed text", () => {
  const r = report({
    version: "1.2.3",
    engine: "abc1234",
    userAgent: "UA",
    paths,
    trace: [
      { t: 1, k: "→ edit", d: { file: "chapters/Intro.tex", start: 5, end: 5, text: "my private sentence" } },
      { t: 2, k: "→ open", d: { main: "Thesis.tex", files: { "Thesis.tex": "\\documentclass{article} secret body" } } },
    ],
    diagnostics: [{ severity: "error", code: "tex", message: "Citation `doe2020' undefined", file: "Thesis.tex", line: 4 }],
    errors: ["status: core trapped: RuntimeError: unreachable: panicked at /home/lambda/src/lib.rs:1:1"],
  });
  for (const secret of ["my private sentence", "secret body", "doe2020", "Thesis", "Intro", "lambda"]) assert.ok(!r.includes(secret), `leaks ${secret}:\n${r}`);
  assert.match(r, /file2\.tex/);
  assert.match(r, /engine abc1234/);
});
