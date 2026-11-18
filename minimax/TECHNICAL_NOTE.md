# One-page technical note

## Structure

`src/cli.mjs` is the single entry point. `ContextStore` reads a manifest, stores the referenced file contents and metadata in seekdb, and emits a bounded JSON context. `PowerContextClient` saves explicit task progress and retrieves it for later calls. The business directory is deliberately small so the same target and regression tests can prove a real code change without environmental ambiguity.

## Context selection

Each imported document has a stable ID, kind (`task`, `specification`, `code`, or `test`), source path, title, symbols, SHA-256, full text and deterministic 96-dimensional embedding. For one task the module issues four related searches: task intent, specifications, implementation symbols, and verification compatibility. seekdb performs full-text plus vector search and database-side reciprocal-rank fusion. Results are deduplicated by stored ID, grouped by their retrieved metadata, and returned with real source paths and excerpts. There is no hard-coded answer table.

Re-import uses `upsert` and refreshes the full-text index. The integration test edits a specification from V1 to V2, re-imports it, and checks that the later context contains V2 but not V1.

## Technology responsibilities

| Technology | Runtime responsibility | Evidence |
| --- | --- | --- |
| MiniMax M3.1-Flash | Generate the replacement `filterReleases` implementation from a sanitized summary derived from the selected context | `evidence/minimax-development-record.md`, `evidence/code-diff.patch` |
| seekdb Server | Persist specification/code/test/task documents and indexes; execute the four hybrid queries used to build context | `evidence/seekdb-import-before.json`, `evidence/context-before-patch.json`, `tests/context-store.test.js` |
| PowerContext 1.5.2 | Persist explicit progress/verification state in a trusted Scope and recall it in later fresh CLI processes | `evidence/logs/powercontext-integration.txt`, `scripts/verify-powercontext.mjs` |

## State and trust boundaries

The operator creates and selects the Scope. Neither task input nor model output can choose it. PowerContext history is treated as historical context; current specifications and current test results remain authoritative. Tokens are read from the environment and are never placed in URLs, output, memory text or committed files.

Each CLI invocation is a new process. The integration verifier starts from a newly created empty Scope, saves one record, then invokes `resume` and `context` in separate processes. The restored content therefore cannot come from in-memory JavaScript state.

## Modification proof

The unchanged behavior test file runs against a retained before snapshot and the submitted implementation. The before run has two functional target failures while four regressions pass; the submitted code passes all six. This demonstrates the requested behavior was absent, was added by code rather than test relaxation, and preserved prior constraints.
