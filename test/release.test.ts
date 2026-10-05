import { test } from "node:test";
import assert from "node:assert/strict";
import { older } from "../extension/src/version.ts";

test("older compares versions part by part, numerically", () => {
  assert.equal(older("0.1.0", "0.2.0"), true);
  assert.equal(older("0.2.0", "0.2.0"), false);
  assert.equal(older("0.10.0", "0.9.9"), false);
  assert.equal(older("0.9.9", "0.10.0"), true);
  assert.equal(older("1.0", "1.0.1"), true);
  assert.equal(older("1.0.1", "1.0"), false);
});
