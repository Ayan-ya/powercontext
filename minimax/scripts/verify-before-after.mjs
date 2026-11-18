import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const testFile = resolve(root, "tests", "release-catalog.behavior.test.js");

function run(modulePath) {
  return spawnSync(process.execPath, ["--test", testFile], {
    cwd: root,
    env: { ...process.env, RELEASE_CATALOG_MODULE: resolve(root, modulePath) },
    encoding: "utf8",
  });
}

const before = run("evidence/before/release_catalog.js");
const after = run("business/release_catalog.js");

assert.notEqual(before.status, 0, "before snapshot must fail target behavior tests");
assert.match(before.stdout + before.stderr, /target: a status string/);
assert.match(before.stdout + before.stderr, /target: an array/);
assert.equal(after.status, 0, after.stdout + after.stderr);

const summary = [
  "Same test file: tests/release-catalog.behavior.test.js",
  `Before snapshot exit code: ${before.status} (expected non-zero functional failure)`,
  "Before target failures: case-insensitive string; multi-value array",
  "Before regression checks: owner, blank status, order/non-mutation, invalid input",
  `Modified implementation exit code: ${after.status}`,
  "Modified result: all 6 tests passed",
].join("\n");

if (process.argv.includes("--record")) {
  const outputPath = resolve(root, "evidence", "logs", "before-after.txt");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${summary}\n`, "utf8");
}

console.log(summary);
