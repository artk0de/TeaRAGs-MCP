# domains/ingest/pipeline/enrichment — writes provider signals onto stored chunks, and closes out what it missed

## Invariants

- **Every payload write is scoped by `op.key` to `` `${providerKey}.file` `` or
  `` `${providerKey}.chunk` ``, and the payload carries BARE inner keys**
  (`{ fanIn, fanOut }`, never `{ codegraph: { file: … } }`). Binds
  `EnrichmentApplier` (applier.ts:295, 343, 348, 436, 556),
  `EnrichmentBackfiller` (backfiller.ts:72, 159), `recovery.ts`, and any schema
  migration
  (`maintenance/migration/schema_migrations/schema-v9-enrichedat-backfill.ts`).
  Qdrant `set_payload` with a nested `key` assigns at that path and preserves
  siblings; a root write does not. `enrichedAt` obeys the same split. Why: both
  levels share the SAME physical points — `#applyFinalizeFile` writes
  `<provider>.file` onto every chunk id of a file, `#applyChunkSignals` writes
  `<provider>.chunk` onto those same ids. A root write erases the sibling level,
  the run still reports success, and the loss surfaces at query time.
- **`CodegraphPayloadHealer` is the SECOND writer of
  `codegraph.symbols.{chunk,file}.*`** (`codegraph-payload-heal.ts`). It
  rewrites points OUTSIDE the run's `chunkMap` whose derived signals moved
  because the graph around them did, always after `applyFinalizeFile` and the
  deferred chunk pass, as `CompletionRunner` step 7b. It obeys the same two
  rules as the applier — level-scoped `op.key` with bare inner keys, and no
  write over a level already carrying `skippedAs` — and it stamps the run's
  `enrichedAt` like any other write of those keys. HOW it finds those points is
  a cost decision taken once per heal off `countPoints`: per-file exact scrolls
  when `targetFiles * 2 < collectionPoints * 0.018`, one unfiltered streaming
  pass otherwise (~1 file per 111 points; ~200 files on the 22k-point
  self-index). Both shapes share the grouping, flush, throw and touched-id
  semantics, and only the pass logs progress. Why the constants: a pass costs
  0.018 ms per point of the COLLECTION, a per-file scroll ~2 ms whatever the
  collection holds — and the scroll is only affordable because exact matching on
  `relativePath` now rides the text index as a text+value pair
  (`adapters/qdrant/filters/text-indexed-exact.ts`, bd tea-rags-mcp-ivp12).
  Before that each one was a full scan, 677–1002 ms apiece, 19 m 16 s for the
  first heal's 1,032 files. It does NOT own the signal arithmetic: both builders
  are injected closures over the codegraph trajectory's
  `buildCodegraphFileSignals` / `buildCodegraphChunkSignals`, composed in
  `api/internal/infra/codegraph-payload-heal-runner.ts` because this domain may
  not import `domains/trajectory`. Why: a third writer that computes the payload
  itself instead of calling those builders drifts from the applier with nothing
  failing — the two write the same keys on the same points, and only a live
  query shows which one was last.
- **A point a provider declined MUST get `<provider>.<level>.skippedAs`** — one
  of `"generated" | "test" | "documentation" | "policy"` (policy.ts:35).
  `"policy"` is the mandatory catch-all when no classification flag explains the
  decline (`enrichmentSkipReason`, policy.ts:77). `skippedAs` and `enrichedAt`
  are mutually exclusive terminal states of one decision, which is why
  `EnrichmentRecovery#buildUnenrichedFilter` (recovery.ts:352-361) is the
  conjunction `is_empty(enrichedAt) AND is_empty(skippedAs)`. Only
  `EnrichmentApplier#applySkipStamps` (applier.ts:136) writes the stamp — it
  owns the whole `<provider>.<level>` subtree; the decision stays in policy.ts.
  **Corollary:** loosening a provider's `shouldEnrich` MUST clear the now-stale
  stamps. Why: an unstamped decline stays a recovery candidate on every run
  forever; a stale stamp hides the point from recovery permanently. No mechanism
  enforces the corollary — it is an obligation on the edit.

## Mechanics

- **Per-run state lives ONLY in the freshly allocated `RunState`**
  (coordinator.ts:56, `createRunState` at :742 — own applier / filePhase /
  chunkPhase / backfiller / completion). `beginRun` is synchronous, overwrites
  `currentRun` immediately, and does NOT wait on the previous run; orphaned
  promise closures keep mutating their own now-unreferenced `RunState`. The one
  exception is `recomputeEnrichments`, which awaits the previous run's in-flight
  completion before it scrolls or opens its run: that completion's
  `releaseCollection` drops the worker-side provider state the recompute's
  deferred pass reads, and its terminal marker would land under the recompute's
  `_run` (bd tea-rags-mcp-71n0p / u3e77). There is no FIFO serialization and no
  `prefetch()` entry point (streaming replaced whole-repo prefetch).
  `EnrichmentMarkerStore` and `EnrichmentRecovery` stay constructor-time
  singletons on purpose — no per-run state, pure Qdrant proxies. Why: isolation
  is allocation-based and nothing else. Add a long-lived mutable field to a
  phase class, or reintroduce reset-in-place, and two overlapping runs corrupt
  each other's counts.
- **Recovery does not compute chunk signals for a provider with
  `defersChunkEnrichment`; it hands its owed chunks in extractable files to the
  reindex run, and heals the non-extractable ones in place — no walk can add a
  symbol to them.** `EnrichmentRecovery#recoverAll` returns them as a
  `DeferredChunkRecoveryHandoff`. `ReindexPipeline#reindexChanges` drops the
  files it re-chunks, narrows the rest through
  `EnrichmentCoordinator#narrowDeferredChunkHandoff`, forces those files into
  `runRepairPass` even when their hash matches, and seeds them with
  `seedDeferredChunks` right after `beginRun` on both closers — the
  finalize-only run and the chunk pipeline's. Seeded paths stay out of the
  codegraph heal's skip set, since they carry only the owed chunks, not the
  whole file. Why: codegraph maps a chunk to its symbol only through
  `chunkSymbolByLine`, which only a walk writes. Recovery runs before any walk,
  so healing there stamped `enrichedAt` over empty overlays, and a
  payload-`symbolId` fallback resolved `#part` chunks to the outer symbol where
  the deferred pass picks the nested one (bd tea-rags-mcp-fxio5). A seeded chunk
  whose file the run never walks gets the same empty stamp, which is why the
  narrowing and the forced walk promise the same set.
- **Codegraph is pinned to one worker thread by `routingKey = collectionName`**
  — the ONLY provider declaring a `workerDescriptor`
  (`dispatch: "collection-affinity"`, `src/bootstrap/factory.ts:564`).
  `executor/worker-pool.ts#routingKeyFor` (:65) pins `streamFileBatch`, deferred
  chunk work, finalize AND `releaseCollection` (:196) to one thread, keeping the
  accumulated symbolTable / chunkSymbolByLine coherent. Git declares NO
  descriptor and dispatches INLINE (worker-pool.ts:19-30, factory.ts:273) —
  affinity measured ~4× slower for it; `"stateless"` exists in the type, unused.
  Release is explicit (no LRU, no idle timeout) and `infra/worker.ts:167-182`
  deletes the cache entry BEFORE awaiting `onRelease`, so a throw still bounds
  memory. The pool disables the liveness timeout (worker-pool.ts:110-116). Why:
  calling git "stateless dispatch" is wrong both ways — git never reaches the
  pool, and a provider marked `stateless` round-robins and loses affinity state
  mid-run. An affinity worker crash still loses that collection's accumulated
  run state — only the recovery scan heals THAT — but the pool slot itself is
  respawned, so the next dispatch is not posted to a dead handle.
- **Pass-1 EXTRACTION is the one thing that leaves the pinned worker.** A
  provider may declare `workerDescriptor.extractionFanout`; codegraph does
  (`factory.ts`). `ExtractionFanoutDispatcher` (`executor/extraction-fanout.ts`)
  then splits a file batch, dispatches `extractFileBatch` with NO routingKey so
  the pool's `findFreeStatelessThread` picks UNPINNED workers, and sends the
  records back through `absorbExtractedFiles` on the affinity key. Absorb,
  finalize, deferred chunk work and release are untouched — the single-writer
  invariant holds because only absorb touches the store or run state. Three
  things gate it: the batch is not `crossPass` (there the chunker already
  parsed), the run earns a spare worker (next bullet), and
  `CODEGRAPH_PASS1_FANOUT` is not `0`. The dispatcher — not the provider — owns
  the per-run "already extracted" set, reset from `coordinator.beginRun` via
  `executor.beginRun`. Why: the file phase batches CHUNKS and a recompute reads
  them back in scroll order, so one file's chunks are scattered across many
  batches; the provider's own `extracted` guard used to absorb that redundancy
  AFTER the parse, and once the parse moved off-thread, dedup had to move BEFORE
  dispatch or the same file is parsed once per batch it appears in.
- **`INGEST_TUNE_ENRICHMENT_POOL_SIZE` is a CEILING, not an allocation.** A
  slot's worker is spawned by its FIRST dispatch (this pool is the only one that
  passes `WorkerDispatchPool`'s `spawnOnDemand`; the chunker stays eager), and a
  run takes
  `clamp(ceil(files / INGEST_TUNE_ENRICHMENT_FILES_PER_THREAD), 1, poolSize)`
  extraction threads from the `fileCount` that reached `executor.beginRun` — an
  UNCOUNTED run (0/undefined) keeps the full width, since "not counted" is not
  evidence of "small". Why: on ugnest (234 Python files, pass 1 = 1.10 s) a pool
  of 4 carried 115 MB more than a pool of 1 at RECOMPUTE_SCROLL and 245 MB more
  at ALL_COMPLETE, for three threads that corpus cannot keep busy; an isolate
  plus its module load costs ~200 ms and only earns it at ~400 files. Large
  corpora are untouched — taxdome's ~19,000 hit the ceiling on the first
  comparison.
- **With the liveness timeout off, a per-thread HEAP CEILING is the only bound
  on a runaway provider** — `ENRICHMENT_WORKER_MEMORY_LIMIT_MB`, default 6144
  (raised from 2048 once the whole-project `ts.Program` strategy put the
  measured taxdome peak at 5,375 MB heapUsed), `0` disables, applied as
  `resourceLimits.maxOldGenerationSizeMb` by `ThreadTransport`. Breaching it
  kills that thread with `ERR_WORKER_OUT_OF_MEMORY`, which arrives as a
  transport `error` — and `WorkerDispatchPool#bindHandle` must therefore RECYCLE
  the slot, not merely clear `busy`. A process-wide
  `NODE_OPTIONS --max_old_space_size` OVERRIDES the per-worker limit, making the
  ceiling inert with no error anywhere; `infra/heap-ceiling-enforcement.ts`
  compares declared against `v8.getHeapStatistics().heap_size_limit` at worker
  boot and says so once. The kill leaves NO post-mortem of its own — no
  exception, and the thread's buffered stdout goes with it — so
  `ENRICHMENT_WORKER_HEAPSNAPSHOT_DIR` (off by default) is what puts
  `--heapsnapshot-near-heap-limit=1` on the thread's `execArgv`. Why: a
  `worker_threads` error is terminal and posting to a dead handle is silently
  discarded, so without the respawn the ceiling converts a slow host-wide
  degradation into a dispatch that never settles for the rest of the run (bd
  8qf86) — and a ceiling set BELOW the shipped configuration's working set turns
  that same mechanism into a guaranteed kill on every host that enforces it.

## Gotchas

- **`enrichedAt` is the run's `startedAt`, not a write timestamp** — threaded
  coordinator.ts:481-489 → `filePhase.init` / `chunkPhase.init`, held as
  `runStartedAt`, so every point one run touches shares an identical value.
  `EnrichmentRecovery#recoverAll` is the exception (one timestamp per pass,
  recovery.ts:317). It IS stamped bare on a genuine no-result (file outside the
  git window, applier.ts:336-352; chunk ids with no commits, :576-598) so those
  points leave the recovery set; it is NOT stamped on a policy decline. Why:
  absence of `enrichedAt` alone no longer means "never reached", and a point
  carrying both stamps is a contradiction — branch on the conjunction the
  recovery filter uses, not on `enrichedAt`.

## Boundaries

- **Streamable per stored batch: git file signals, git chunk signals, codegraph
  edge EXTRACTION (side effects only, empty overlay map). NOT streamable:
  codegraph file signals** (fanIn/fanOut/instability/ isHub/transitiveImpact
  need the complete graph) **and codegraph chunk signals** (PageRank/SCC need
  the complete method graph) — hence `streamFileBatch` + `finalizeSignals` +
  `defersChunkEnrichment` on `EnrichmentProvider`
  (`contracts/types/provider.ts:366-396`); where the deferred chunk pass sits in
  `CompletionRunner`'s step order is `../../../trajectory/codegraph/CLAUDE.md`.
  At finalize only PER-COLLECTION maps drop by key; the run-global ancestor /
  extends / return-type / dispatch maps reset instance-wide via
  `runState.clearForNextRun()` (takes no key), and `chunkSymbolByLine` is
  deliberately KEPT past finalize. Why: the deferred chunk pass still reads
  `chunkSymbolByLine` — "cleaning it up" at finalize empties the chunk-level
  codegraph signals with no error anywhere.
- **`classify()` (`core/infra/file-classification/`) is the FACT; `shouldEnrich`
  is per-provider POLICY**, and the two policies deliberately diverge: git
  declines generated, gives docs `file-only`, keeps tests at `full`
  (`trajectory/git/provider.ts:238-242` — ownership is legitimate); codegraph
  declines generated plus its own exclusion filter, which takes tests out
  unconditionally and says nothing about docs — that filter is owned by
  `../../../trajectory/codegraph/CLAUDE.md`. `FileClassification` is NOT
  duplicated — `infra/file-classification/classify.ts` imports and re-exports it
  from `contracts/types/file-classification.ts`. Why: collapsing both into one
  shared boolean loses a deliberate divergence, and re-creating an infra-local
  copy of the type contradicts the foundation order that legalized the type-only
  edge.

## See also

- `.claude/rules/git-cat-file-batch.md`,
  `.claude/rules/deep-path-navigation.md`, `.claude/rules/domain-boundaries.md`,
  `.claude/rules/migrations.md`, `../CLAUDE.md`, `../../CLAUDE.md`
