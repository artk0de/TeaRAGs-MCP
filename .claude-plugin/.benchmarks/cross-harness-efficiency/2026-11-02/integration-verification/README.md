# Focused latest-main verification

The original default-config attempt was interrupted after over60 seconds without
a test summary. It is incomplete, not a failing-test verdict. No cause was
established. The two explicit-config runs cover17 direct checks and the4 missing
ping controls, all passing. Neither group was silently rerun until green.

The configs retain repository setup, worktree HEAD guard, globals, clearMocks
semantics, fork isolation,30s budgets and retry0. They omit full-corpus module
classification/projects and disable the transformed-module disk cache. This
does not establish which default-run component accounted for its delay.

To reproduce with the recorded relative config roots, copy the two config files
to `<repo>/.tmp/p0-sentinel-integration/`, then run Vitest from `<repo>` with
`--config .tmp/p0-sentinel-integration/vitest.affected.config.ts --maxWorkers=1`
and separately `--config .tmp/p0-sentinel-integration/vitest.ping.config.ts
--maxWorkers=1`. No build, indexing, native model actor or full suite is required.
These checks overlapped the root-authorized behavioral cohort; no timing or
provider-causality conclusion is supported.
