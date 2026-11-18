import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "src", "cli.mjs");
const urlArgument = process.argv.indexOf("--url");
const url =
  (urlArgument >= 0 ? process.argv[urlArgument + 1] : undefined) ??
  process.env.POWERCONTEXT_URL ??
  "http://127.0.0.1:8000";
const token = process.env.POWERCONTEXT_TOKEN ?? "";
const temporary = mkdtempSync(resolve(tmpdir(), "minimax-pc-"));
const db = resolve(temporary, "context.db");

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args, "--url", url, "--db", db], {
    cwd: root,
    env: { ...process.env, POWERCONTEXT_TOKEN: token },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

try {
  run(["init", "--manifest", "samples/release-filter/manifest.json", "--reset"]);
  const unique = `${Date.now()}-${process.pid}`;
  const scope = run(["scope", "--idempotency-key", `minimax-sdd-${unique}`]).scope_id;

  const empty = run(["resume", "--scope", scope, "--task-id", "SDD-REL-001"]);
  assert.equal(empty.status, "empty", "a new scope must start without task state");

  const saved = run([
    "save",
    "--scope",
    scope,
    "--record",
    "samples/release-filter/task-state.json",
  ]);
  assert.ok((saved.records ?? []).length > 0);

  // Every run() starts a fresh Node process, so this is a real module restart.
  const resumed = run(["resume", "--scope", scope, "--task-id", "SDD-REL-001"]);
  assert.equal(resumed.status, "ready");
  assert.match(resumed.content ?? "", /task_id SDD-REL-001/);
  assert.match(resumed.content ?? "", /status verified/);

  const context = run([
    "context",
    "--scope",
    scope,
    "--task-id",
    "SDD-REL-001",
    "--task",
    "Make release status filters accept normalized strings and arrays while preserving compatibility",
  ]);
  assert.equal(context.restoredState.status, "ready");
  assert.ok(context.applicableSpecifications.length >= 2);
  assert.ok(context.codeLocations.some((item) => item.symbols === "filterReleases"));
  assert.ok(context.verificationTests.length >= 1);

  const summary = [
    `PowerContext URL: ${url}`,
    "New scope initially empty: yes",
    `Saved record count: ${saved.records.length}`,
    "Fresh-process resume status: ready",
    "Resumed state used in task context: yes",
    `seekdb returned sources: ${context.database.returnedDocumentCount}`,
    "Required specification/code/test source groups present: yes",
  ].join("\n");
  if (process.argv.includes("--record")) {
    const outputPath = resolve(root, "evidence", "logs", "powercontext-integration.txt");
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${summary}\n`, "utf8");
  }
  console.log(summary);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
