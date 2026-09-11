---
paths:
  - "src/core/domains/maintenance/drift/**"
  - "tests/core/domains/maintenance/drift/**"
---

# Index Drift (MANDATORY)

`maintenance/drift/` compares what an index STAMPED at index time against what
the current build or environment would produce now. Everything here is a pure
comparison. The line that decides what belongs:

- **Compare → here.** Reads a stamp (stats cache `payloadFieldKeys`, registry
  `languageVersions` / `env` / `indexedCommit`), reads the current value,
  returns `IndexDriftFinding[]`. No I/O beyond those reads.
- **Side effect → elsewhere.** Throws on mismatch (`EmbeddingModelGuard`,
  `adapters/qdrant/`), decides to spawn (`maintenance/freshness/`), upgrades a
  store (`maintenance/migration/`), rewrites payload
  (`ingest/pipeline/enrichment/`). Those may CONSUME a finding; they never live
  here.

## One report, one remedy

Every monitor implements `IndexDriftMonitor#check(collectionName)`.
`IndexDriftReporter` folds the findings over
`none < incremental < recompute(trajectories, languages?) < force` (`remedy.ts`)
and `formatIndexDriftReport` renders ONE `Run:` line. A consumer that prints two
commands for one collection is a defect — add the monitor to the reporter in
`src/bootstrap/factory.ts`, do not render it separately. The search path shows
each report once per collection per REPORT SIGNATURE per process, so a clean
check consumes nothing and a changed report warns again.

## An enable-flag finding is about the process that READS the index

`CODEGRAPH_ENABLED` and `TRAJECTORY_GIT_ENABLED` are diffed against the RUNNING
composition's resolved flag, not against the effective env (spec decision 6), so
a finding names the reading process rather than the index. `tea-rags prime` is
not that process for the codegraph flag: `run-prime.ts` re-applies
`CODEGRAPH_ENABLED` from the registry identity field BEFORE `parseAppConfig`
(the codegraph-env-parity fix), so prime's composition always carries it and the
finding can never appear in a prime run — by design, not a defect. Verify that
one against an MCP server process started without the flag, through
`get_index_status` or a search `driftWarning`. `TRAJECTORY_GIT_ENABLED` gets no
such re-apply and fires in prime: exported `false` it prints
`TRAJECTORY_GIT_ENABLED: true → false (explains any git.* payload-key drift — restore the flag instead of rebuilding)`,
and unset it prints nothing, because the default is true.

## Adding a monitor

1. Decide the stamp: what the index run writes, where, and whether it is sticky
   (`registry/CLAUDE.md`). A monitor with no stamp compares nothing.
2. `readonly axis: IndexDriftAxis` — extend the union in `monitor.ts`.
3. Each finding's `remedy` comes from the lattice; `force` only when the chunk
   set moves, `recompute` names its trajectories, `languages: null` when the
   finding is collection-wide.
4. Register in `factory.ts`; tests in `tests/core/domains/maintenance/drift/`
   with a fake registry / stats cache — never a live Qdrant.
5. If the finding's cause has a rule (`language-capability-sync.md`,
   `index-format-versions.md`, `migrations.md`), link it from the finding's
   `note`, do not restate it.

## Why not `teaRagsVersion`

A package-version axis would flag drift on every release. The stamps above are
narrower and each names its own remedy.
