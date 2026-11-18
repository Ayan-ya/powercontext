#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { ContextStore } from "./context-store.mjs";
import { PowerContextClient } from "./powercontext-client.mjs";

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required --${name}`);
  }
  return value.trim();
}

function powerContext(options) {
  return new PowerContextClient({
    baseUrl: options.url ?? process.env.POWERCONTEXT_URL ?? "http://127.0.0.1:8000",
    token: options.token ?? process.env.POWERCONTEXT_TOKEN ?? "",
  });
}

function databasePath(options) {
  return resolve(
    options.db ?? process.env.MINIMAX_CONTEXT_DB ?? resolve("data", "context.db"),
  );
}

async function output(value, path) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (path) await writeFile(resolve(path), json, "utf8");
  process.stdout.write(json);
}

async function withStore(options, callback) {
  const store = await new ContextStore(databasePath(options)).open();
  try {
    return await callback(store);
  } finally {
    await store.close();
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "init") {
    const result = await withStore(options, async (store) => {
      if (options.reset) await store.reset();
      return store.importManifest(required(options, "manifest"));
    });
    await output(result, options.out);
    return;
  }

  if (command === "context") {
    const taskId = required(options, "task-id");
    const task = required(options, "task");
    const scope = options.scope ?? process.env.POWERCONTEXT_SCOPE;
    let state = { status: "not_requested", content: null };
    if (scope) state = await powerContext(options).prepareTaskState(scope, taskId);
    const result = await withStore(options, (store) => store.buildTaskContext(task, state));
    await output({ taskId, ...result }, options.out);
    return;
  }

  if (command === "scope") {
    const result = await powerContext(options).createScope({
      title: options.title ?? "MiniMax SDD Context",
      summary: options.summary ?? "Task progress and verification results for the SDD sample.",
      idempotencyKey: options["idempotency-key"] ?? "minimax-sdd-context-v1",
    });
    await output(result, options.out);
    return;
  }

  if (command === "save") {
    const scope = required({ ...options, scope: options.scope ?? process.env.POWERCONTEXT_SCOPE }, "scope");
    const state = JSON.parse(await readFile(resolve(required(options, "record")), "utf8"));
    const result = await powerContext(options).saveTaskState(scope, state);
    await output(result, options.out);
    return;
  }

  if (command === "resume") {
    const scope = required({ ...options, scope: options.scope ?? process.env.POWERCONTEXT_SCOPE }, "scope");
    const result = await powerContext(options).prepareTaskState(
      scope,
      required(options, "task-id"),
    );
    await output(result, options.out);
    return;
  }

  throw new Error(
    "Usage: cli.mjs <init|context|scope|save|resume> [--option value]",
  );
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
});
