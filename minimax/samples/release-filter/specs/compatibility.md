# Compatibility constraints

- `COMPAT-001`: owner filtering remains exact and case-sensitive.
- `COMPAT-002`: no filters returns the same releases in their original order.
- `COMPAT-003`: filtering must not mutate the input array or release objects.
- `COMPAT-004`: a non-array releases argument continues to throw `TypeError`.
