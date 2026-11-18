# MiniMax SDD Context

This submission implements a small specification-driven development context module and proves it with task `SDD-REL-001`. The CLI imports real specification, code and test files into seekdb, queries them to assemble a task context, and restores task progress from PowerContext. The retained before snapshot and the modified business module run against the same test file.

All commands below run from `minimax/`. No credentials are committed.

## Components and versions

- Node.js 20 or later; verified with Node.js 24.15.0.
- `seekdb` npm package 1.3.0 with `@seekdb/js-bindings` 1.4.0.
- `oceanbase/seekdb:latest` Server image, isolated on host port 2882.
- PowerContext Server 1.5.2, installed with the `cli,server` extras.
- MiniMax Code, model `M3.1-Flash`, used for the business-function modification recorded in `evidence/minimax-development-record.md`.

## Clean setup

```bash
npm ci
docker compose up -d seekdb
npm run check
npm test
npm run verify:patch
```

`npm test` includes a real seekdb Server test. It changes a specification, re-imports the same document ID, and confirms that a later database query returns the new content instead of a fixed answer.

Install and start PowerContext in a separate terminal:

```bash
uv tool install --force "powercontext[cli,server]==1.5.2"
powercontext server run --host 127.0.0.1 --port 18080 --env-file config/powercontext.env
```

Then run the cross-process integration test:

```bash
node scripts/verify-powercontext.mjs --url http://127.0.0.1:18080
```

The script creates a new Scope and first proves it is empty. It saves the sample task state, starts a fresh Node process for every subsequent CLI call, resumes the state, and uses that state in a new seekdb-backed task context.

## CLI input and output

Initialize or refresh indexed project material:

```bash
node src/cli.mjs init \
  --manifest samples/release-filter/manifest.json \
  --reset
```

Input is a manifest whose entries provide a stable ID, kind, title and real source path. Output reports the seekdb mode, collection, imported count, source path and SHA-256 for each stored file.

Build a development context:

```bash
node src/cli.mjs context \
  --task-id SDD-REL-001 \
  --task "Make release status filters accept normalized strings and arrays while preserving compatibility"
```

Output is JSON with `applicableSpecifications`, `codeLocations`, `verificationTests`, actual database queries and optional `restoredState`. Every source path in the output exists in this directory.

Create, save and resume PowerContext state:

```bash
node src/cli.mjs scope --url http://127.0.0.1:18080
node src/cli.mjs save --url http://127.0.0.1:18080 --scope SCOPE_ID \
  --record samples/release-filter/task-state.json
node src/cli.mjs resume --url http://127.0.0.1:18080 --scope SCOPE_ID \
  --task-id SDD-REL-001
```

Pass the same `--scope` to `context` to include the restored progress in its output. A trusted application selects the Scope; task or model text never chooses it. If authentication is enabled, set `POWERCONTEXT_TOKEN`; the CLI never prints it.

## Verification sample

The full expected sources, steps and results are in `VALIDATION_SAMPLE.md`. The short path is:

```bash
node scripts/verify-before-after.mjs
```

The script runs `tests/release-catalog.behavior.test.js` unchanged against both:

- `evidence/before/release_catalog.js`: two target failures, four regression passes.
- `business/release_catalog.js`: all six tests pass.

The failure is missing behavior, not a missing dependency or startup error.

## Updating a specification

Edit `samples/release-filter/specs/status-filter.md`, run `init` again without `--reset`, then rerun `context`. The stable document ID is upserted; the returned excerpt and SHA-256 change. `tests/context-store.test.js` automates this exact V1-to-V2 proof with seekdb.

## Evidence map

- `evidence/context-before-patch.json`: database-generated task context supplied to the development workflow.
- `evidence/seekdb-import-before.json`: stored source paths and content hashes before the patch.
- `evidence/seekdb-import-after.json`: stored source paths and content hashes after the patch.
- `evidence/minimax-development-record.md`: model, sanitized request, response and patch correspondence.
- `evidence/code-diff.patch`: retained functional change.
- `evidence/logs/before-after.txt`: same-test-set result.
- `evidence/logs/powercontext-integration.txt`: empty, save, fresh-process resume and context-use result.
- `TEST_RESULTS.md`: commands, exit codes and coverage summary.
- `TECHNICAL_NOTE.md`: one-page architecture and responsibility split.

## Reset

Stop services with `docker compose down`. To remove only this sample's database state, use `docker compose down -v` after confirming the Compose project is `minimax`. PowerContext sample state lives under ignored `data/powercontext`; deleting that directory resets it.

## Known limits

- The deterministic 96-dimensional embedding is intended for a small engineering corpus, not general semantic search. Full-text and vector candidates are fused by seekdb RRF.
- PowerContext 1.5.2 is used without inference providers because this workflow writes explicit authorized task state and uses lexical recall.
- The sample is intentionally a local CLI rather than a complete development Agent; the problem statement allows CLI entry points and reuse of an existing Agent.
