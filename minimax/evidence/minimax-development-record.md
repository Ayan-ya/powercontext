# MiniMax development record

Status: authenticated MiniMax response captured and reconciled with the tested patch.

## Task and selected context

Task `SDD-REL-001` asks for normalized single/multiple status filtering while preserving exact owner matching, order, non-mutation and invalid-input behavior. seekdb selected the full sources recorded in `context-before-patch.json`: two specifications, `filterReleases`, the unchanged target/regression test file and the task definition.

The browser safety boundary did not permit sending private repository files verbatim to an external service. A sanitized functional summary was therefore prepared without repository paths, hashes, credentials, private source text or test code.

## MiniMax request

- Product: MiniMax Code (`https://agent.minimax.cn/`)
- Model shown by the product: `M3.1-Flash`
- Requested output: one complete JavaScript ES module, no test or specification changes
- Authenticated browser session date: 2026-11-18

The exact sanitized request sent to MiniMax was:

```text
Write only a complete JavaScript ES module that exports function filterReleases(releases, filters = {}). Requirements: throw TypeError when releases is not an array; keep owner matching exact and case-sensitive; status may be one string or an array of strings; trim status values and compare case-insensitively; blank or non-string status values do not restrict results; multiple statuses use any-match semantics; preserve input order and never mutate the input array or objects. Do not include markdown fences or explanation.
```

## Response and application

MiniMax returned the following complete module in the authenticated session:

```js
export function filterReleases(releases, filters = {}) {
  if (!Array.isArray(releases)) {
    throw new TypeError('filterReleases(releases, filters): releases must be an array.');
  }

  const options = filters !== null && typeof filters === 'object' ? filters : {};
  const owner = options.owner;
  const hasOwner = owner !== undefined && owner !== null;
  const statuses = normalizeStatuses(options.status);
  const hasStatus = statuses.length > 0;

  if (!hasOwner && !hasStatus) {
    return releases.slice();
  }

  return releases.filter((release) => {
    if (release === null || release === undefined) {
      return false;
    }

    if (hasOwner && release.owner !== owner) {
      return false;
    }

    if (hasStatus) {
      const status = typeof release.status === 'string'
        ? release.status.trim().toLowerCase()
        : '';

      if (!statuses.includes(status)) {
        return false;
      }
    }

    return true;
  });
}

function normalizeStatuses(status) {
  const candidates = Array.isArray(status) ? status : [status];
  const normalized = [];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed === '') {
      continue;
    }

    normalized.push(trimmed.toLowerCase());
  }

  return normalized;
}

export default filterReleases;
```

The page displayed the complete code response before showing a subsequent account-credit banner, so the response itself was not truncated.

The implementation in `business/release_catalog.js` was reconciled with this response and the repository contract:

- MiniMax's `normalizeStatuses` loop maps directly to the `requestedStatuses` filter/map pipeline in the patch.
- Both implementations accept a scalar or array, discard blank and non-string filter values, trim values, lowercase them and use `includes` for any-match behavior.
- Both keep the owner comparison exact and case-sensitive and use `Array.prototype.filter`, preserving order without mutating the input.
- The repository keeps its established named-export-only API and existing TypeError message instead of adding MiniMax's extra default export or changing the public error text.
- The repository keeps its existing scalar normalization for release status values while adopting MiniMax's normalized multi-status selection logic.

The exact applied repository change is recorded in `evidence/code-diff.patch`; the shared before/after test evidence is in `evidence/logs/before-after.txt`.
