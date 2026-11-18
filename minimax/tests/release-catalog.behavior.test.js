import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

const modulePath = resolve(
  process.env.RELEASE_CATALOG_MODULE ?? "business/release_catalog.js",
);
const { filterReleases } = await import(`${pathToFileURL(modulePath).href}?run=${Date.now()}`);

const releases = [
  { id: "r1", owner: "platform", status: "Draft" },
  { id: "r2", owner: "platform", status: "READY" },
  { id: "r3", owner: "mobile", status: "ready" },
];

test("target: a status string is trimmed and case-insensitive", () => {
  assert.deepEqual(
    filterReleases(releases, { status: " ready " }).map(({ id }) => id),
    ["r2", "r3"],
  );
});

test("target: an array matches any normalized status", () => {
  assert.deepEqual(
    filterReleases(releases, { status: [" draft "] }).map(({ id }) => id),
    ["r1"],
  );
});

test("regression: owner matching remains exact", () => {
  assert.deepEqual(
    filterReleases(releases, { owner: "platform" }).map(({ id }) => id),
    ["r1", "r2"],
  );
  assert.deepEqual(filterReleases(releases, { owner: "Platform" }), []);
});

test("regression: blank status does not restrict results", () => {
  assert.deepEqual(filterReleases(releases, { status: "  " }), releases);
});

test("regression: filtering preserves order and does not mutate input", () => {
  const snapshot = structuredClone(releases);
  assert.deepEqual(filterReleases(releases), releases);
  assert.deepEqual(releases, snapshot);
});

test("regression: invalid releases input still throws TypeError", () => {
  assert.throws(() => filterReleases(null), TypeError);
});
