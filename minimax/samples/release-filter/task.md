# Task SDD-REL-001

Change `filterReleases` so status filters accept one or more values and compare them case-insensitively after trimming. Preserve exact owner matching, stable input order, non-mutation, and the existing invalid-input error.

The target tests must fail against the retained before snapshot because the behavior is absent, then pass against the modified implementation. Regression tests must pass in both runs.
