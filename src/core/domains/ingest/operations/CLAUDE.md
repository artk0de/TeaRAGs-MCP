# domains/ingest/operations — full index / incremental reindex orchestration and collection-version resolution

## Invariants

- **The incremental work set is `added ∪ modified ∪ quarantined`.**
  `ReindexPipeline` unions the scanner's sets with every path currently in
  `quarantine.json`, regardless of whether content changed
  (`ReindexPipeline#reindexChanges`:
  `[...changes.added, ...changes.modified, ...retryPaths]`, and `addedFiles` in
  `reindex-parallel-executor.ts#planReindexExecution`).
  `ReindexPipeline#computeQuarantineRetry` takes EVERY key in the store,
  filtered only to paths still on disk and not already queued — no attempts cap,
  no `permanent-fail` promotion. The early returns in
  `ReindexPipeline#reindexChanges` explicitly refuse to short-circuit a
  pure-retry pass. Success clears the entry (`SourceFileIngestor#ingest`);
  failure bumps `attempts` + `lastFailedAt`. Why: the fix usually ships in
  tea-rags itself (better chunker, larger context window), not in the user's
  file. Trimming the work set to "what actually changed" strands every
  quarantined file forever, since their content is precisely what never changes.
- **A scoped force enters the work set as MODIFIED, via the snapshot — never by
  a side list.** `ReindexPipeline#invalidateRechunkWorkSet` selects the indexed
  files a `RechunkFileSelector` matches (`selectRechunkWorkSet`,
  `rechunk-work-set.ts`) and PERSISTS their snapshot entries as stale
  (`ParallelFileSynchronizer#invalidateEntries`: `mtime: 0`, a sentinel hash)
  BEFORE change detection and before any point is deleted. From there the
  ordinary modified path does the rest: delete by path, re-chunk, embed, upsert,
  codegraph DELETE+INSERT per file, enrichment for those chunks only. Why: the
  persisted mark IS the crash safety — a run that dies part-way leaves the
  unfinished files stale on disk, so the next run of any kind (auto-update
  included) re-chunks them; a work set held only in memory would lose them, and
  a separate delete/upsert path would duplicate the ordering the modified path
  already gets right.
- **Every early return of `ReindexPipeline#reindexChanges` owes the providers'
  whole-collection work its finalize would have done.** The no-change and
  deletion-only returns open no enrichment run, so no `finalizeSignals` fires;
  unless their repair finalize ran to completion,
  `ReindexPipeline#completeCollectionUnlessFinalized` asks
  `EnrichmentCoordinator#runCollectionCompletion`, which calls each provider's
  `completeCollection`. Every other run shape — first index, `--force`, a delta,
  a scoped force that selected files, the recompute leg of `--force-enrichments`
  — reaches the same `completeCollection` from
  `EnrichmentCoordinator#completeRun` once its completion settled, on the main
  thread and never from inside the worker's finalize (bd tea-rags-mcp-vtuu4);
  the sync leg of `--force-enrichments`, the auto-updater and MCP
  `index_codebase` all ARE `reindexChanges`.
  `tests/core/domains/ingest/operations/collection-completion-paths.test.ts`
  pins one case per path. Why: codegraph's co-change graph is a function of HEAD
  and the working tree's deletions, both of which exactly these runs move — a
  committed `git rm` took the deletion-only return and left the deleted file's
  pairs and the old HEAD standing (bd tea-rags-mcp-l1ot.2). The ask is cheap
  when nothing moved (two git spawns and one meta read) and must stay so: every
  quiet reindex pays it.
- **Finalize the alias BEFORE storing the completion marker, and signal failure
  by THROWING.** The order lives ONCE, in `BaseIndexingPipeline#sealRun`:
  `promote` → `storeIndexingMarker(…, true, …)` → `persist` →
  `#recordRegistryEntry`. `IndexPipeline#indexCodebase` supplies
  `#finalizeAlias` as `promote` and `#saveSnapshot` as `persist`;
  `ReindexPipeline#reindexSealSpec` has no `promote`. Every return of both
  pipelines closes through it (bd tea-rags-mcp-7njy). Raw failures are wrapped
  by `BaseIndexingPipeline#wrapUnexpectedError` into `IndexingFailedError`
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
