# domains/maintenance/drift — stamps compared, never written

## Mechanics

- **Every monitor is a pure read.** Inputs are the stats cache
  (`payloadFieldKeys`), the registry entry (`languageVersions`, `env`,
  `RegistryGitState`) and the current build's declarations; the writers live in
  `ingest/pipeline/base.ts` (registry record),
  `api/internal/ops/indexing-ops.ts` (`stampLanguageVersions`) and
  `infra/stats-cache.ts`. A monitor that needs a value nobody stamps has found a
  missing stamp, not a place to compute one.
- **`IndexDriftReporter` owns consumption.** `checkAndConsume` shows a
  collection once per process; `IndexingOps` calls `reset(collectionName)` after
  every run's stamps. A monitor never tracks "already shown".
- **The `Run:` line comes from the fold, not from a monitor.** A finding carries
  a lattice `remedy`; `foldIndexDriftRemedies` picks the maximum and unions
  recomputes; `renderIndexDriftRemedy` fills `--project` from
  `IndexDriftReport.projectAlias` (registry name resolved by the reporter).
  Rendering a command inside a monitor is a defect.
- **`EnvDriftMonitor` never reads `process.env`.** Its second constructor
  argument is the effective-env resolver the composition root builds (outer
  env > stored registry env > code default, the same replay
  `ProjectIngestFactory` performs). Comparing against the bare process env
  reports phantom drift for every project whose registry env differs.
- **`*` is a language to the version monitor.** `sharedVersions`
  (`language/kernel/capability.ts`) is compared unconditionally; its findings
  render with no `--languages`.

## Gotchas

- An empty language distribution silences only the PER-LANGUAGE claims.
  `LanguageVersionDriftMonitor#check` reads which languages an index holds from
  the stats cache; with no distribution it makes no per-language claim, but `*`
  is still compared. A collection indexed before stats existed therefore reports
  the shared axes and nothing else — silence on `ruby` means "unknown", not
  "clean". Genuine silence on this axis is a collection with no registry entry.
- A removed payload key folds to `none`; a report can therefore be non-empty and
  still say "No action required."

## See also

- `.claude/rules/index-drift.md` — boundary, lattice, how to add a monitor.
- `../CLAUDE.md` — the flag-conditional descriptor gotcha this directory
  inherits.
