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
