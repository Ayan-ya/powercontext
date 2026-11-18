import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextStore } from "../src/context-store.mjs";

test("seekdb context changes when a specification is updated and re-imported", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "minimax-sdd-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "sources"));

  const manifestPath = join(root, "manifest.json");
  const specPath = join(root, "sources", "spec.md");
  await writeFile(specPath, "SPEC-V1 status matching is case sensitive.\n", "utf8");
  await writeFile(join(root, "sources", "code.js"), "export function filterReleases() {}\n", "utf8");
  await writeFile(join(root, "sources", "test.js"), "test('status filter', () => {});\n", "utf8");
  await writeFile(
    manifestPath,
    JSON.stringify({
      documents: [
        { id: "spec", kind: "specification", title: "Status spec", source: "sources/spec.md" },
        { id: "code", kind: "code", title: "Implementation", source: "sources/code.js", symbols: ["filterReleases"] },
        { id: "test", kind: "test", title: "Behavior test", source: "sources/test.js" },
      ],
    }),
    "utf8",
  );

  const collectionName = `minimax_sdd_test_${process.pid}_${Date.now()}`;
  const store = await new ContextStore(join(root, "context.db"), collectionName).open();
  context.after(async () => {
    await store.drop();
    await store.close();
  });
  await store.importManifest(manifestPath);
  const first = await store.buildTaskContext("change release status filter");
  assert.equal(first.database.engine, "seekdb");
  assert.ok(first.applicableSpecifications.some((item) => item.excerpt.includes("SPEC-V1")));
  assert.ok(first.codeLocations.some((item) => item.symbols === "filterReleases"));
  assert.ok(first.verificationTests.length > 0);

  await writeFile(specPath, "SPEC-V2 status matching trims and ignores case.\n", "utf8");
  await store.importManifest(manifestPath);
  const second = await store.buildTaskContext("change release status filter");
  const specificationText = second.applicableSpecifications.map((item) => item.excerpt).join("\n");
  assert.match(specificationText, /SPEC-V2/);
  assert.doesNotMatch(specificationText, /SPEC-V1/);
});
