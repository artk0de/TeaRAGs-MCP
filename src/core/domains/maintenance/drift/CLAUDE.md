# domains/maintenance/drift — stamps compared, never written

## Mechanics

- **Who writes the stamps a monitor reads.** The registry record — `env` and
  `RegistryGitState` included — is written by `ingest/pipeline/base.ts`;
  `languageVersions` by `IndexingOps#stampLanguageVersions`
  (`api/internal/ops/indexing-ops.ts`) — and, for a collection seeded from a
  sibling worktree, the seeding build's stamp by `IndexingOps#stampWorktreeSeed`
  (`../worktree/CLAUDE.md`); `payloadFieldKeys` by `infra/stats-cache.ts`. A
  monitor that needs a value none of them writes has found a missing stamp, not
  a place to compute one.
- **`IndexDriftReporter` owns consumption.** The two consuming checks —
  `checkAndConsume` (by path) and `checkAndConsumeByCollectionName`, both of
  them search — show a collection once per REPORT SIGNATURE per process, so a
  clean check spends nothing and a report that grew a finding warns again;
  `IndexingOps` calls `reset(collectionName)` after every run's stamps, which
  clears every signature recorded for it. A monitor never tracks "already
  shown".
- **The path-addressed checks resolve the way a SEARCH does.** `checkByPath` and
  `checkAndConsume` turn a path into a collection through the
  `resolveCollectionForPath` callback the composition root passes the reporter
  (`api/internal/collection-resolver.ts`, `createPathCollectionResolver`:
  registry entry first, path hash only for a path no entry claims), so a
  relocated project is reported and consumed under the collection its searches
  query instead of under what its new path happens to hash to. Re-deriving the
  hash here is the defect, not a shortcut.
- **`--project` comes from the reporter.** `renderIndexDriftRemedy` fills it
  from `IndexDriftReport.projectAlias`, which the reporter resolves through the
  `resolveAlias` callback the composition root passes it
  (`collectionRegistry.get(name)?.name`). Rendering a command inside a monitor
  is a defect.
- **`EnvDriftMonitor` never reads `process.env`.** Its second constructor
  argument is the effective-env resolver the composition root builds (outer
  env > stored registry env > code default, the same replay
  `ProjectIngestFactory` performs). Comparing against the bare process env
  reports phantom drift for every project whose registry env differs.
- **`EnvDriftMonitor`'s `CODEGRAPH_ENABLED` finding is unreachable from prime**
  — the registry re-apply is `../CLAUDE.md`, the ruling
  `.claude/rules/index-drift.md`.
- **`*` is a language to the version monitor.** `sharedVersions`
  (`language/kernel/capability.ts`) is compared unconditionally; its findings
  render with no `--languages`.
- **`StatsContractDriftMonitor` shares its judgement with the stats migration.**
  Both call `judgeStatsContract` (`stats-contract-drift.ts`) — the monitor to
  report, `StatsStoreAdapter#getStatsContractState` to decide whether
  `StatsV7SamplingContract` has work. Two implementations would eventually
  disagree, and then prime reports a drift no reindex clears, or clears one it
  never reported. It is also the only axis whose remedy is `incremental`: the
  values are on the payload already, so the migration repairs it inside a plain
  run.

## Gotchas

- An empty language distribution silences only the PER-LANGUAGE claims.
  `LanguageVersionDriftMonitor#check` reads which languages an index holds from
  the stats cache; with no distribution it makes no per-language claim, but `*`
  is still compared. A collection indexed before stats existed therefore reports
  the shared axes and nothing else — silence on `ruby` means "unknown", not
  "clean". Genuine silence on this axis is a collection with no registry entry.
- A removed payload key folds to `none`; a report can therefore be non-empty and
  still say "No action required."
- **`statsContract` is deliberately NOT a worktree-seed axis**, against step 6
  of `.claude/rules/index-drift.md`. The rule's premise — an uncompared axis is
  drift the seed silently copies — does not hold here: the seeded run continues
  as an ordinary incremental through `prepareReindexContext`, so `runMigrations`
  judges the cloned stats file and `StatsV7SamplingContract` rebuilds it inside
  that same run. Gating the seed on it would reject an otherwise perfect sibling
  — re-embedding the whole repository, ~92% of a first index's wall clock — to
  avoid a file the run repairs for free.

## See also

- `.claude/rules/index-drift.md` — boundary, lattice, how to add a monitor.
- `../CLAUDE.md` — the flag-conditional descriptor gotcha this directory
  inherits.
