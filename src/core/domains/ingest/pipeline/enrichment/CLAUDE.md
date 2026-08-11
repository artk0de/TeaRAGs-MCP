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
  promise closures keep mutating their own now-unreferenced `RunState`. There is
  no FIFO serialization and no `prefetch()` entry point (streaming replaced
  whole-repo prefetch). `EnrichmentMarkerStore` and `EnrichmentRecovery` stay
  constructor-time singletons on purpose — no per-run state, pure Qdrant
  proxies. Why: isolation is allocation-based and nothing else. Add a long-lived
  mutable field to a phase class, or reintroduce reset-in-place, and two
  overlapping runs corrupt each other's counts.
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
  mid-run. An affinity worker crash loses that collection's run state with no
  auto-respawn; only the recovery scan heals it.

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
