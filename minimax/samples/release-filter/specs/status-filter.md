# Release status filter specification

- `SPEC-STATUS-001`: `filters.status` accepts one string or an array of strings.
- `SPEC-STATUS-002`: status comparison trims surrounding whitespace and ignores ASCII case.
- `SPEC-STATUS-003`: missing, blank, or non-string status filter values do not restrict results.
- `SPEC-STATUS-004`: an array matches a release when any normalized requested status matches.

This is the authoritative current specification. Re-importing this file after an edit must change the context returned by the CLI.
