# domains/maintenance — lifecycle state OUTSIDE the index: registry, footprint clones, freshness, migrations, drift

## Invariants

- **The freshness verdict is computed against the REGISTERED project path, never
  the session cwd.** `IndexFreshnessCheck#check`
  (`freshness/freshness-check.ts:57-66`) reads live git state from `entry.path`
  and compares `state.branch` against that same entry's
  `autoUpdate.targetBranch`. A worktree session querying the main project's
  index therefore triggers an auto-update of the MAIN checkout, evaluated at the
  MAIN checkout's HEAD. Why: the caller's cwd never enters the decision, so
  "auto-update fired against the wrong branch" is almost always this — the index
  being refreshed belongs to the registered project, not to whoever asked.

## Mechanics

- **Auto-update debounce is two-layered but single-constant.**
  `AutoUpdateTrigger#maybeSpawn` (`src/bootstrap/auto-update/trigger.ts`, one
  instance per process) keeps an in-memory `collectionName → lastChecked` map
  and returns `in-memory-debounced` BEFORE `IndexFreshnessCheck#check` runs; the
  check then applies the CROSS-PROCESS layer by reading `autoUpdate.lastRun`
  (`freshness/freshness-check.ts:68-80`), written by the detached updater at the
  end of its run. Both layers read the SAME exported `AUTO_UPDATE_RUN_TTL_MS`
  (`freshness-check.ts:19`) — the trigger imports it from `core/api/public`.
  `AUTO_UPDATE_FAILURE_BACKOFF_MS` (`:26`) applies only to the cross-process
  failed-run branch. Why: changing the TTL moves BOTH layers at once; what is
  genuinely split is ownership, not tuning — the in-memory map lives in
  `bootstrap`, a layer this domain cannot import, so the in-process half cannot
  be tested or changed from here.

## Gotchas

- **Every database migration ships twice, and only the `.ts` twin reaches
  production.** Each migration exists as
  `migration/database/migrations/NNN-name.ts` (SQL as an exported string) and a
  byte-twin `NNN-name.sql`. Production loads ONLY the `.ts`, through the
  hand-maintained `DATABASE_MIGRATIONS` array in `migrations/index.ts:29-47`
  (registration points for all five pipelines: `.claude/rules/migrations.md`).
  The `.sql` exists solely because `runMigrations`
  (`migration/database/runner.ts:37-47`) also accepts a directory, a path only
  tests take; `tsc` does not copy `.sql` into `build/` (`runner.ts:12-15`). Why:
  adding a migration is THREE edits (both files plus the array). A `.sql` that
  drifts from its `.ts` changes nothing at runtime and fails no build, so the
  drift is invisible until someone runs the disk path. The ledger keys on the
  FILENAME string in `schema_migrations` (`runner.ts:41-58`), so renaming an
  already-applied file re-runs it.
- **Drift compares FEATURE-FLAG-dependent descriptors against index-time keys.**
  `SchemaDriftMonitor`'s `currentPayloadKeys` (`schema-drift-monitor.ts:17`) is
  NOT read from Qdrant — it is the payload-signal descriptor set the CURRENT
  composition declares (`src/bootstrap/factory.ts`:
  `composition.allPayloadSignalDescriptors` + `"navigation"`), compared against
  the `payloadFieldKeys` the stats cache recorded at index time. Codegraph
  descriptors are flag-conditional (`api/internal/composition.ts`, deps supplied
  only when `CODEGRAPH_ENABLED`), so a process built with different flags
  reports drift with zero code changed. `CollectionEntry.codegraphEnabled`
  (`contracts/types/registry.ts:74-84`) is persisted purely so `prime` can
  re-apply the flag registry-first before building its composition
  (`src/cli/prime/run-prime.ts`). Why: a drift report is routinely read as "the
  payload schema changed, reindex" — when the actual fix is env parity in the
  process that ran the check. The `prime` SessionStart hook runs in a fresh
  shell and is the standing offender.

## See also

- `.claude/rules/migrations.md` — the five pipelines, where a new migration is
  registered, and the live end-to-end verification protocol.
- `.claude/rules/domain-boundaries.md` — why the registry and migration
  framework live here rather than in `core/infra/`.
- `registry/CLAUDE.md`, `footprint/CLAUDE.md`, `worktree/CLAUDE.md` — sibling
  navigators.
