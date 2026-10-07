// Source ↔ page from glyph origins (sync.ts), and the UTF-8 ↔ UTF-16 offsets it uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boxes, from, glyphs, lineAt, nearest } from "../extension/src/vendor/viewer/sync.ts";
import { byteOffset, charOffset } from "../extension/src/edits.ts";

// "main" (the job's name for main.tex) and a file not in the project; one glyph with no source.
const gs = glyphs(
  { files: ["main", "article.cls"], g: [[100, 200, 0, 10, 11, 0], [105, 200, 0, 11, 12, 0], [100, 212, 0, 20, 21, 0], [130, 200, 1, 0, 5, 1], [140, 200, -1, 0, 0, 1]] },
  (n) => (n === "main" ? "main.tex" : null),
);

test("names map to project paths; no source is null", () => {
  assert.deepEqual(gs.map((g) => g.file), ["main.tex", "main.tex", "main.tex", null, null]);
});

test("a double-click finds the nearest glyph with a source, a line apart weighing more", () => {
  assert.equal(nearest(gs, 106, 197)?.start, 11);
  assert.equal(nearest(gs, 101, 210)?.start, 20);
  // (nothing but glyphs without a source to the right: still the nearest that has one)
  assert.equal(nearest(gs, 141, 197)?.start, 11);
});

test("a source place finds its line's glyphs, on the printed line nearest it", () => {
  const hit = from(gs, "main.tex", 0, 30);
  assert.equal(hit.length, 3);
  assert.deepEqual(lineAt(hit, 11).map((g) => g.start), [10, 11]);
  assert.deepEqual(lineAt(hit, 25).map((g) => g.start), [20]);
  const [b] = boxes(lineAt(hit, 11), gs);
  assert.deepEqual(b, [99, 192, 12, 11]);
});

test("charOffset inverts byteOffset", () => {
  const s = "aé😀b\nx";
  for (let i = 0; i <= s.length; i++) if (!(i === 3)) assert.equal(charOffset(s, byteOffset(s, i)), i);
});
