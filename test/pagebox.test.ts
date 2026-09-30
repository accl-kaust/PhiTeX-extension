import { test } from "node:test";
import assert from "node:assert/strict";
import { approximateFraction, pageBox } from "../extension/src/panel.ts";

test("approximateFraction, as pdf.js", () => {
  assert.deepEqual(approximateFraction(1), [1, 1]);
  assert.deepEqual(approximateFraction(2), [2, 1]);
  assert.deepEqual(approximateFraction(1.5), [3, 2]);
  assert.deepEqual(approximateFraction(1.1), [8, 7]);
  assert.deepEqual(approximateFraction(1.25), [5, 4]);
});

test("a Letter page at 101% and dpr 1.1 is Overleaf's 819 × 1064", () => {
  const w = 612 * (96 / 72) * ((864 - 40) / (612 * (96 / 72)));
  assert.deepEqual(pageBox({ w: 612, h: 792 }, w, 1.1), [819, 1064]);
});
