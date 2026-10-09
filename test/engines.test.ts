import { test } from "node:test";
import assert from "node:assert/strict";
import { approximable } from "../common/src/vendor/viewer/engines.ts";
test("approximable: fontspec and friends, not CJK", () => {
  const doc = (pre: string) => `\\documentclass{article}\n${pre}\n\\begin{document}x\\end{document}`;
  assert.equal(approximable(doc("\\usepackage{fontspec}\\setmainfont{Inter}")), true);
  assert.equal(approximable(doc("\\usepackage{polyglossia,unicode-math}")), true);
  assert.equal(approximable(doc("\\usepackage{fontspec}\\usepackage{xeCJK}")), false);
  assert.equal(approximable("\\documentclass{ctexart}\\begin{document}x\\end{document}"), false);
  assert.equal(approximable(doc("\\usepackage{luacode}")), false);
  assert.equal(approximable(doc("\\usepackage{amsmath}")), false);
});
