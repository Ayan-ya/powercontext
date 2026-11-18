# Test results

Verified on 2026-11-18 with Node.js 24.15.0, seekdb npm 1.3.0 / bindings 1.4.0, `oceanbase/seekdb:latest`, and PowerContext 1.5.2.

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run check` | 0 | CLI, store and PowerContext client syntax valid |
| `npm test` | 0 | 10 passed, including real seekdb V1-to-V2 re-import |
| `node scripts/verify-before-after.mjs --record` | 0 | before: exit 1 with two target failures and four regressions passing; after: six passed |
| `node scripts/verify-powercontext.mjs --url http://127.0.0.1:18080 --record` | 0 | empty Scope, one saved record, fresh-process ready recall, recalled state used in context |
| `npm audit --omit=dev` | 0 | zero production vulnerabilities |

The same behavior test file is used before and after. No test is skipped and no expected value changes between runs. Source hashes for the exact before-context inputs are in `evidence/seekdb-import-before.json`.
