import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, unseen, type News } from "../extension/src/news.ts";

const news: News[] = ["0.3.0", "0.2.1", "0.2.0", "0.1.0"].map((version) => ({ version, date: "", title: version, items: [] }));

test("versions compare as numbers", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.2.0", "0.2.1"), -1);
});

test("unseen: newer than what was seen, not newer than what is installed", () => {
  assert.deepEqual(unseen("0.1.0", "0.2.1", news).map((n) => n.version), ["0.2.1", "0.2.0"]);
  assert.deepEqual(unseen("0.3.0", "0.3.0", news), []);
});
