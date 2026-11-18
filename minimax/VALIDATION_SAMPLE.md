# Validation sample: SDD-REL-001

## What must change

`filterReleases` must accept `filters.status` as one string or an array, trim each string and compare it without ASCII case sensitivity. Multiple values use any-match semantics.

## What must remain unchanged

- Owner matching is exact and case-sensitive.
- Missing or blank status does not restrict results.
- Input order is stable and input values are not mutated.
- A non-array `releases` value throws `TypeError`.

## Required context sources

| Kind | Required source | Required item |
| --- | --- | --- |
| Specification | `samples/release-filter/specs/status-filter.md` | `SPEC-STATUS-001` through `SPEC-STATUS-004` |
| Specification | `samples/release-filter/specs/compatibility.md` | `COMPAT-001` through `COMPAT-004` |
| Code | `business/release_catalog.js` | `filterReleases` |
| Tests | `tests/release-catalog.behavior.test.js` | two target tests and four regression tests |
| Task | `samples/release-filter/task.md` | `SDD-REL-001` |

`evidence/context-before-patch.json` contains all five sources and records the four queries executed against seekdb.

## Initial data

- Manifest: `samples/release-filter/manifest.json`.
- Before implementation: `evidence/before/release_catalog.js`.
- State record: `samples/release-filter/task-state.json`.
- seekdb collection: `minimax_sdd_context` in the dedicated Server on port 2882.

## Steps and expected results

1. Run `docker compose up -d seekdb`, `npm ci`, and `node src/cli.mjs init --manifest samples/release-filter/manifest.json --reset`.
   Expected: five documents imported and all source paths/hashes printed.
2. Run the `context` command in `README.md`.
   Expected: both specification sources, symbol `filterReleases`, the behavior test, the task source, `engine: seekdb`, and four database queries.
3. Run `node scripts/verify-before-after.mjs`.
   Expected: the before snapshot exits 1 because exactly the two target behaviors are missing; its four regression checks pass. The modified implementation exits 0 with six passing tests.
4. Start PowerContext and run `node scripts/verify-powercontext.mjs --url http://127.0.0.1:18080`.
   Expected: a new Scope is empty, one record is saved, a fresh process resumes `status: ready`, and another fresh process includes the restored state in the seekdb-backed context.
5. Copy the status specification to a temporary sample, change `SPEC-V1` to `SPEC-V2`, and re-import it, or run `npm test` for the automated form.
   Expected: a later database query includes only V2 content.

## Reset

`docker compose down -v` removes this Compose project's seekdb volume. Delete ignored `data/powercontext` only when the PowerContext Server is stopped. The next run starts from empty state.
