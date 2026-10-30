# Recovered SWE-rebench work

Recovered on 2026-10-30 from the local `recover/swe-rebench` branch and its
`.claude/worktrees/swe-rebench-restored` working tree. Its original HEAD was
`e847eb5dc5238ee3d529cb363405cd1e83f41d4c`.

## Original snapshot

`tree/` preserves all 36 originally modified or untracked files with their
repository-relative paths. This includes benchmark source, tests, task data,
the private navigation design and preregistration, scratch scripts, and a result
report. `manifest.json` records original statuses, sizes, and SHA256 hashes;
`status.z.gz` losslessly preserves the original machine-readable Git status.
The repository forbids raw NUL bytes in staged text, so this NUL-delimited
record is stored as gzip. `encoded-originals.json` records the original and
stored SHA256 hashes; `gzip -dc status.z.gz` restores the original bytes.
`tracked.patch` preserves the original tracked working-tree diff.

These files are historical evidence. They are not a second source tree to edit
or execute as part of the product build. Ignored virtual environments and caches
were not part of the original dirty-file snapshot.

## Integrated source

The public source, tests, README, and task list were recovered in commit
`66e71abdc438731975e36a928a04ce14755b16bc`
(`feat(evals): recover rebench, Pro, probe and localization stages`) on
`recover/swe-rebench`. The commit contains 18 public files and adds compatibility
for current MCP column-table responses and explicit working-tree addressing.
The recovered benchmark suite passed 125 tests.

`public-recovery-commit.patch` preserves that commit, including the compatibility
changes. `public-recovery-summary.json` records its scope and ancestry checks.
The original files under `tree/` intentionally predate those compatibility fixes.

The initial local preservation copy was
`/private/tmp/tea-rags-recovered-swe-rebench-20261030T020930Z-d4586d39`.
This repository research directory is the user-requested archival destination.
