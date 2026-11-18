import assert from "node:assert/strict";
import test from "node:test";
import { DIMENSIONS, embed } from "../src/embedding.mjs";

test("embedding is deterministic and normalized", () => {
  const first = embed("status filter READY");
  const second = embed("status filter READY");
  assert.deepEqual(first, second);
  assert.equal(first.length, DIMENSIONS);
  assert.ok(Math.abs(Math.hypot(...first) - 1) < 1e-12);
});

test("embedding handles empty input without NaN", () => {
  const result = embed("");
  assert.equal(result.length, DIMENSIONS);
  assert.ok(result.every((value) => value === 0));
});
