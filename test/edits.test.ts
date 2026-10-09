import { test } from "node:test";
import assert from "node:assert/strict";
import { Batch, byteOffset, merge, apply, sequential, utf8Len, type ByteEdit, type Edit } from "../common/src/vendor/viewer/edits.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Apply byte edits to UTF-8 bytes, as PhiTeX does. */
function applyBytes(s: string, es: ByteEdit[]): string {
  let b = enc.encode(s);
  for (const e of es) {
    const t = enc.encode(e.text);
    const n = new Uint8Array(b.length - (e.end - e.start) + t.length);
    n.set(b.subarray(0, e.start));
    n.set(t, e.start);
    n.set(b.subarray(e.end), e.start + t.length);
    b = n;
  }
  return dec.decode(b);
}

const samples = ["plain ascii", "Héllo wörld", "∑ x² — “quotes”", "emoji 😀 and 👩‍👩‍👧 family", "日本語のテキスト", "a\u0301 combining", ""];

test("utf8Len matches TextEncoder", () => {
  for (const s of samples) assert.equal(utf8Len(s), enc.encode(s).length, s);
  assert.equal(utf8Len("\ud800"), 3); // (lone surrogate: U+FFFD)
});

test("byteOffset at every UTF-16 position", () => {
  for (const s of samples)
    for (let i = 0; i <= s.length; i++) {
      const b = byteOffset(s, i);
      // (inside a pair, the pair's start)
      const j = i > 0 && /[\udc00-\udfff]/.test(s[i] ?? "") && /[\ud800-\udbff]/.test(s[i - 1]) ? i - 1 : i;
      assert.equal(b, enc.encode(s.slice(0, j)).length, `${s} @${i}`);
    }
});

test("sequential: a ChangeSet's simultaneous changes, one after another", () => {
  // doc "abcdef": replace b→XY and e→"" at once; new doc "aXYcdf"
  const changes: [number, number, number, number, string][] = [
    [1, 2, 1, 3, "XY"],
    [4, 5, 5, 5, ""],
  ];
  const es = sequential((f) => changes.forEach((c) => f(...c)));
  assert.equal(es.reduce(apply, "abcdef"), "aXYcdf");
});

function rnd(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
const alphabet = ["a", "b", " ", "\n", "é", "ö", "∑", "😀", "日", "\\"];

function randomEdit(r: () => number, s: string): Edit {
  // (never inside a surrogate pair, as CodeMirror)
  const at = () => {
    let p = Math.floor(r() * (s.length + 1));
    if (p > 0 && p < s.length && /[\udc00-\udfff]/.test(s[p])) p--;
    return p;
  };
  let from = at(), to = at();
  if (from > to) [from, to] = [to, from];
  if (r() < 0.5) to = from; // (typing)
  let text = "";
  const n = r() < 0.3 ? 0 : 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) text += alphabet[Math.floor(r() * alphabet.length)];
  return { from, to, text };
}

test("merge = one then the other", () => {
  const r = rnd(7);
  for (let k = 0; k < 5000; k++) {
    const s0 = "Héllo 😀 wörld ∑ \\bye\n".repeat(1 + Math.floor(r() * 3));
    const a = randomEdit(r, s0);
    const s1 = apply(s0, a);
    const b = randomEdit(r, s1);
    const m = merge(s0, a, b);
    if (m) assert.equal(apply(s0, m), apply(s1, b), JSON.stringify({ s0, a, b, m }));
  }
});

test("typing merges into one edit", () => {
  const b = new Batch("Hi \n");
  for (const [i, c] of [..."wörld😀"].entries()) b.push({ from: 3 + [..."wörld😀"].slice(0, i).join("").length, to: 3 + [..."wörld😀"].slice(0, i).join("").length, text: c });
  b.push({ from: b.text.length - 3, to: b.text.length - 1, text: "" }); // (backspace over 😀: two code units)
  const es = b.take();
  assert.equal(es.length, 1);
  assert.equal(applyBytes("Hi \n", es), b.text);
});

test("batch: random edits, in bytes, keep order and meaning", () => {
  const r = rnd(42);
  for (let k = 0; k < 500; k++) {
    let s = "Héllo 😀 wörld ∑ \\bye\n";
    const batch = new Batch(s);
    let bytes = s;
    for (let round = 0; round < 5; round++) {
      const n = 1 + Math.floor(r() * 8);
      for (let i = 0; i < n; i++) {
        const e = randomEdit(r, s);
        s = apply(s, e);
        batch.push(e);
      }
      assert.equal(batch.text, s);
      const es = batch.take();
      assert.ok(es.length <= n);
      bytes = applyBytes(bytes, es);
      assert.equal(bytes, s);
    }
  }
});
