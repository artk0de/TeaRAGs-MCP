# domains/ingest/operations — full index / incremental reindex orchestration and collection-version resolution

## Invariants

- **The incremental work set is `added ∪ modified ∪ quarantined`.**
  `ReindexingOps` unions the scanner's sets with every path currently in
  `quarantine.json`, regardless of whether content changed
  (`ReindexPipeline#prepareParallelExecution`:
  `[...changes.added, ...changes.modified, ...retryPaths]`, and `addedFiles`).
  `ReindexPipeline#computeQuarantineRetry` takes EVERY key in the store,
  filtered only to paths still on disk and not already queued — no attempts cap,
  no `permanent-fail` promotion. The early returns in
  `ReindexPipeline#reindexChanges` explicitly refuse to short-circuit a
  pure-retry pass. Success clears the entry (`SourceFileIngestor#ingest`);
  failure bumps `attempts` + `lastFailedAt`. Why: the fix usually ships in
  tea-rags itself (better chunker, larger context window), not in the user's
  file. Trimming the work set to "what actually changed" strands every
  quarantined file forever, since their content is precisely what never changes.
- **Finalize the alias BEFORE storing the completion marker, and signal failure
  by THROWING.** The order in `IndexingOps` is fixed: `#finalizeAlias` →
  `storeIndexingMarker(…, true, …)` → `#saveSnapshot` → `#recordRegistryEntry`
  (`IndexPipeline#indexCodebase`). Raw failures are wrapped by
  `BaseIndexingPipeline#wrapUnexpectedError` into `IndexingFailedError`
  (`IndexPipeline#indexCodebase`) / `ReindexFailedError`
  (`ReindexPipeline#reindexChanges`) and thrown — never returned. One vestige
  survives: the defensive `!setup.ready` guard still sets
  `stats.status = "failed"` and returns (`IndexPipeline#indexCodebase`); it is
  unreachable through the facade (exists-without-force routes to
  `reindexChanges`) and is not a pattern to copy. Why: marker-first leaves a
  collection marked complete while the alias still points at the previous
  version. With this order an alias failure writes no marker, the collection
  stays stale, and orphan cleanup reclaims it.

## Gotchas

- **Anything opened by LITERAL name must be addressed by the alias TARGET, not
  the alias.** Qdrant resolves aliases server-side, so Qdrant calls work either
  way — which is exactly why the bug hid. Path- and handle-deriving consumers do
  not: above all the codegraph DuckDB file, whose path
  `GraphDbClientPool#pathFor` builds straight from the string it is handed
  (`adapters/duckdb/pool.ts`). Passing the alias produced a shadow
  `<alias>.duckdb` no reader ever opened (7 of 44 projects, incl. taxdome and
  tea-rags itself; 6goqa). Route through `resolveAliasTargetCollection`
  (`version-resolver.ts`, used in `ReindexPipeline#prepareReindexContext`). Its
  sibling `findAliasTarget` returns `undefined` distinctly from "points at
  itself" because the force path needs "no alias yet" to not collapse to the
  base name (`IndexPipeline#setupCollection`). Why: the failure is silent and
  one-directional — writes land in a file nobody reads, so recall degrades with
  no error, and every incremental run re-creates the shadow.

## See also

- `.claude/rules/migrations.md`, `.claude/rules/typed-errors.md`,
  `.claude/rules/barrel-files.md`
- `../CLAUDE.md`, `../pipeline/CLAUDE.md`
