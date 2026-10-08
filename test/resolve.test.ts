import { test } from "node:test";
import assert from "node:assert/strict";
import { Index, formatOf, shelfEngine } from "../common/src/resolve.ts";

const tsv = [
  "tex/latex/foo/foo.sty\tfoo-aaaaaaaaaaaa\tbar-aaaaaaaaaaaa\t",
  "tex/xelatex/foo/foo.sty\tfoo.xe-bbbbbbbbbbbb\t\tbaz-bbbbbbbbbbbb",
  "tex/generic/foo/foo.sty\tfoo.gen-cccccccccccc\t\t",
  "tex/latex/zz/only.sty\tzz-dddddddddddd\t\t",
  "tex/latex/aa/only.sty\taa-eeeeeeeeeeee\t\t",
  "fonts/opentype/public/lm/lmroman10-regular.otf\tlm.o-ffffffffffff\t\t",
  "fonts/tfm/public/cm/cmr10.tfm\tcm-gggggggggggg\t\t",
].join("\n");
const ix = new Index(tsv, {
  deps: ["pdftex", "xetex"],
  search: {
    pdftex: { tex: ["tex/latex", "tex/generic", "tex"], tfm: ["fonts/tfm"] },
    xetex: { tex: ["tex/xelatex", "tex/latex", "tex/xetex", "tex/generic", "tex"], opentype: ["fonts/opentype"] },
  },
});

test("a name in tex/xelatex and tex/latex resolves differently for pdftex and xetex", () => {
  assert.equal(ix.resolve("foo.sty", "tex", "pdftex"), "tex/latex/foo/foo.sty");
  assert.equal(ix.resolve("foo.sty", "tex", "xetex"), "tex/xelatex/foo/foo.sty");
  assert.deepEqual(ix.packs("tex/latex/foo/foo.sty", "pdftex"), ["foo-aaaaaaaaaaaa", "bar-aaaaaaaaaaaa"]);
  assert.deepEqual(ix.packs("tex/xelatex/foo/foo.sty", "xetex"), ["foo.xe-bbbbbbbbbbbb", "baz-bbbbbbbbbbbb"]);
});

test("within a prefix the smallest path wins; a path is taken as is; TeX Live's absolute prefix dropped", () => {
  assert.equal(ix.resolve("only.sty", "tex", "pdftex"), "tex/latex/aa/only.sty");
  assert.equal(ix.resolve("tex/latex/zz/only.sty", "tex", "pdftex"), "tex/latex/zz/only.sty");
  assert.equal(ix.resolve("/usr/share/texmf-dist/fonts/opentype/public/lm/lmroman10-regular.otf", "opentype", "xetex"), "fonts/opentype/public/lm/lmroman10-regular.otf");
  assert.equal(ix.resolve("lmroman10-regular.otf", "opentype", "xetex"), "fonts/opentype/public/lm/lmroman10-regular.otf");
});

test("outside the format's prefixes: not found; a format with no list: any path", () => {
  assert.equal(ix.resolve("cmr10.tfm", "tex", "pdftex"), null);
  assert.equal(ix.resolve("cmr10.tfm", "tfm", "pdftex"), "fonts/tfm/public/cm/cmr10.tfm");
  assert.equal(ix.resolve("cmr10.tfm", "nosuch", "pdftex"), "fonts/tfm/public/cm/cmr10.tfm");
  assert.equal(ix.resolve("missing.sty", "tex", "pdftex"), null);
  assert.equal(formatOf("x.otf"), "opentype");
  assert.equal(shelfEngine("xelatex"), "xetex");
});
