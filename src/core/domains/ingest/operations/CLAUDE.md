# domains/ingest/operations — full index / incremental reindex orchestration and collection-version resolution

## Invariants

- **The incremental work set is `added ∪ modified ∪ quarantined`.**
  `ReindexPipeline` unions the scanner's sets with every path currently in
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
  by THROWING.** The order in `IndexPipeline` is fixed: `#finalizeAlias` →
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

- **Collection identity is a TYPE, not a convention: `PhysicalCollectionName`
  versus `CollectionAlias`** (`contracts/types/collection-identity.ts`, bd
  tea-rags-mcp-39xca.1). Qdrant resolves aliases server-side, so Qdrant calls
  work with either name — which is exactly why handing the alias to the
  codegraph pool hid until it produced a shadow `<alias>.duckdb` no reader ever
  opened (7 of 44 projects, incl. taxdome and tea-rags itself; 6goqa). Every
  storage boundary now requires the physical brand, and only
  `infra/collection-name.ts` mints it — `resolvePhysicalCollection` (used in
  `ReindexPipeline#prepareReindexContext` and `IndexingOps`),
  `versionedPhysicalCollectionName` (`claimVersionedCollection`), or a read-back
  from storage; lint rejects the cast anywhere else, and
  `CodegraphDbFiles#writablePathFor` is the runtime backstop. Two ingest-local
  facts the types do not carry: `findAliasTarget` returns `undefined` distinctly
  from "points at itself" because the force path needs "no alias yet" to not
  collapse to the base name (`IndexPipeline#setupCollection`); and
  `resolvePhysicalCollection(name, [])` — resolving against no aliases — is only
  for a name already known concrete (a legacy unversioned collection being
  migrated, a name Qdrant just deleted) or a lookup that failed, never a way
  around a resolution that could have run. Why: the failure is silent and
  one-directional — writes land in a file nobody reads, so recall degrades with
  no error, and every incremental run re-creates the shadow.

## See also

- `.claude/rules/migrations.md`, `.claude/rules/typed-errors.md`,
  `.claude/rules/barrel-files.md`
- `../CLAUDE.md`, `../pipeline/CLAUDE.md`
