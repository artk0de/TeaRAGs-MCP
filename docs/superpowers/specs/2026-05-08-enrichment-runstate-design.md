# Enrichment RunState — Per-Run State Container

## Problem

The post-split enrichment pipeline (see
`2026-05-07-enrichment-coordinator-split-design.md`) cleanly delegates
responsibilities to `EnrichmentApplier`, `FilePhase`, `ChunkPhase`,
`EnrichmentBackfiller`, `CompletionRunner`, and `EnrichmentMarkerStore`. But it
still treats every component as a long-lived singleton owned by the coordinator
constructor. Two production-confirmed bugs follow from that.

### Bug #1 — Applier state leaks across reindex runs

`EnrichmentApplier` (`applier.ts:26-30`) holds:

```ts
matchedFiles = 0;
missedFiles = 0;
readonly missedPathSamples: string[] = [];
private readonly _missedFileChunks = new Map<string, MissedFileChunk[]>();
```

These are instance fields on a class instantiated **once** in
`EnrichmentCoordinator` constructor (`coordinator.ts:85`). Every subsequent
`coordinator.prefetch()` call reuses the accumulated state. There is no reset
path.

Production evidence — `pipeline-2026-05-06T13-44-15.log` (production-rails-app, 6 sequential
incremental reindexes over 4 hours):

```
t=  156s  BACKFILL_START missedFiles=488
t=  216s  BACKFILL_COMPLETE missedFiles=488 backfilledFiles=0 stillMissed=488 durationMs=60013
t= 9330s  BACKFILL_START missedFiles=488          ← same 488 paths
t= 9390s  BACKFILL_COMPLETE backfilledFiles=0     ← timeout again
t=10218s  BACKFILL_START missedFiles=488          ← still the same 488
... repeats 6 times
```

The 488 missed paths are zombies from the first session. Each subsequent
backfill gathers them via `applier.getMissedFileChunks()` and re-attempts
`provider.buildFileSignals(root, { paths: missedPaths })` — which times out at
60s on the union, returns nothing, and leaves `_missedFileChunks` intact for the
next round.

### Bug #2 — Concurrent `prefetch()` corrupts state

`EnrichmentCoordinator.prefetch()` (`coordinator.ts:122-158`) overwrites
`startTime`/`runId`/`runStartedAt` and calls `filePhase.init()` (which does
`states.clear()`) and `chunkPhase.init()`. But the in-flight prefetch promises
from the previous run captured the old `state` reference via closure
(`file-phase.ts:107: const state = this.states.get(ctx.key)`). When the older
promise eventually resolves it:

1. Writes `state.fileMetadata`, `state.prefetchEndTime`, etc. to an orphaned
   object that nobody reads.
2. Calls `chunkPhase.markReady(ctx.key)` on the **fresh** `chunkPhase` —
   confusing the new run's readiness lifecycle.
3. The `EnrichmentApplier` is shared (not orphaned), so any
   `applier.applyFileSignals()` calls triggered from the orphaned `flushPending`
   write to the live applier and pollute the new run's counters.

Production evidence — `pipeline-2026-05-07T15-03-02.log` (production-rails-app force
reindex):

```
t= 524s  PREFETCH_START                                     ← force reindex begins
t=1240s  CHUNK_ENRICHMENT_START files=22292
t=1514s  CHUNK_ENRICHMENT_COMPLETE overlaysApplied=77432
t=2648s  PREFETCH_START (#2)                                ← incremental fires while force still in flight
t=2650s  PREFETCH_COMPLETE filesInLog=5  durationMs=1640    ← incremental
t=2656s  ALL_COMPLETE matchedFiles=5  missedFiles=0         ← incremental finishes
t=2673s  PREFETCH_FILTERED filtered=4527  remainingFiles=43638  ← original force prefetch only now resolves
t=2673s  PREFETCH_COMPLETE filesInLog=48165  durationMs=2148306  ← duration counted from t=524, ~36 min wall clock
t=3525s  BACKFILL_COMPLETE backfilledFiles=7262  stillMissed=1
t=3567s  ALL_COMPLETE matchedFiles=22459  missedFiles=27
         prefetchDurationMs=1640  gitLogFileCount=5  estimatedSavedMs=1640
                                                            ← all three numbers belong to the incremental, not force
```

Final ALL_COMPLETE for the force reindex reports metrics borrowed from the
incremental that interrupted it. Operationally this is a measurement bug, not a
data corruption bug — the 22459+7262 file overlays do land in Qdrant — but the
correctness of the marker / metrics / stats layer is broken.

### Downstream — StatsCache freezes pre-backfill

`onChunkEnrichmentComplete` callback (`coordinator.ts:66-73`, awaited in
`IngestFacade` per the recently-shipped fix from commit 896f343c) fires when
`ChunkPhase` finishes streaming + initial chunk enrichment. But
`CompletionRunner.run()` then proceeds to file backfill + chunk backfill, which
writes 7000+ overlays in the production-rails-app force case. No second stats refresh fires.

User-visible effect: `get_index_metrics` reports `filesWithGitData=5` even
though Qdrant already has 22459+7262 enriched files — because `StatsCache` was
last saved at t=2650s when the incremental's chunk callback fired with only 5
files visible. The cache stays frozen until something else triggers a save.

### Why the existing reset path is insufficient

`FilePhase.init()` clears `this.states` and `ChunkPhase.init()` clears its own
maps. That handles the per-phase containers but does **not** touch:

- `EnrichmentApplier` instance fields (Bug #1 root cause).
- The fact that orphaned promise closures from a previous run still hold and
  mutate stale state (Bug #2 root cause).

Both bugs share one underlying cause: **per-run state is implicit and shared,
not bounded and addressable**. Any reset-in-place strategy would have to chase
every place that captures state by reference and add ceremony. Collapsing the
state into one container resolves both bugs in a single move.

## Goals

1. Eliminate cross-run leakage of applier/file-phase/chunk-phase counters and
   missed-path sets.
2. Make concurrent `coordinator.prefetch()` calls deterministic — no shared
   mutable state between runs.
3. Surface stats refresh after the full enrichment lifecycle (chunk enrichment
   AND backfill) so `StatsCache` matches Qdrant.
4. Preserve the 896f343c contract: streaming work must complete before
   `onChunkEnrichmentComplete` fires for the chunk-enrichment milestone.
5. Keep `enrichment/` public API stable (barrel exports unchanged).
6. No new background sentinels, timers, or heartbeats.

## Non-Goals

- Re-evaluating the 60-second backfill timeout in `provider.buildFileSignals` —
  tracked separately as `tea-rags-mcp-qdrv`. The runstate fix unblocks honest
  backfill scope; the timeout becomes meaningful once the missed set is no
  longer 488 zombies.
- Splitting `EnrichmentApplier` further. The class stays — only its lifetime
  changes.
- Touching `EnrichmentRecovery`. Recovery already operates on a per-collection
  scroll and does not share mutable state across runs.

## Design

### Three axes — chosen approach

1. **State container — Option B (per-run `RunState`).** A single struct binds
   the applier, file-phase state, chunk-phase state, runId, startTime,
   startedAt, and the completion promise. `prefetch()` constructs a fresh
   `RunState`. Old promise closures that resolve later mutate their own
   `RunState` (which is no longer referenced by the coordinator) and have zero
   effect on the new run.
2. **Concurrency — Option A (FIFO serialize).** A new `prefetch()` awaits the
   previous run's `awaitCompletion` before starting. Implementation: one field
   `currentRunPromise: Promise<EnrichmentMetrics> | null`; new prefetch chains
   via `await this.currentRunPromise?.catch(() => undefined)`. Constraint #3
   (re-entrant pipeline) is satisfied — the incremental is never rejected, only
   queued behind the in-flight run.
3. **Stats refresh — Option A (re-fire `onChunkEnrichmentComplete` after
   backfill).** `CompletionRunner.run()` invokes the chunk-phase's `onComplete`
   callback once after the existing chunk-enrichment milestone AND once after
   `CHUNK_BACKFILL_COMPLETE`. The callback is idempotent in `IngestFacade`
   (`refreshStatsByCollection` resolves alias and overwrites the cache); the
   second fire just supersedes the first.

### Scope — Option β (minimal refactor)

`FilePhase` and `ChunkPhase` keep their internal `states: Map<...>` structures.
`RunState` simply owns the applier instance + a reference to the current
phase-state snapshot. The phase classes do not become stateless oracles — they
still do their work — but each `RunState` instance gets a private
`FilePhase`/`ChunkPhase`/`EnrichmentApplier` triplet. The coordinator's delegate
fields (`filePhase`, `chunkPhase`, `applier`, `backfiller`, `completion`) move
from constructor-time singletons to factory-built per-`RunState` instances.

`EnrichmentMarkerStore` and `EnrichmentRecovery` stay singletons — they own no
per-run state and only proxy to Qdrant.

### `RunState` shape

```ts
interface RunState {
  runId: string;
  startTime: number;
  startedAt: string;
  applier: EnrichmentApplier;
  filePhase: FilePhase;
  chunkPhase: ChunkPhase;
  backfiller: EnrichmentBackfiller;
  completion: CompletionRunner;
  contexts: Map<string, ProviderContext>;
  donePromise: Promise<EnrichmentMetrics>;
  resolveDone: (m: EnrichmentMetrics) => void;
  rejectDone: (e: unknown) => void;
}
```

The coordinator owns `currentRun: RunState | null`. The `donePromise` exposed
through the coordinator's `awaitCompletion()` resolves when
`CompletionRunner.run()` finishes for that specific run.

### Sequence — fresh `prefetch()` while previous run still in-flight

```
t0  Caller A: coordinator.prefetch(...)        // creates RunState_A, currentRun = A
t0  Caller A: coordinator.awaitCompletion(...)  // returns A.donePromise (in-flight)

t1  Caller B: coordinator.prefetch(...)
      ├─ const previous = this.currentRun?.donePromise
      ├─ await previous?.catch(() => undefined)  // FIFO serialize
      ├─ build RunState_B with fresh applier/filePhase/chunkPhase
      └─ this.currentRun = B; start prefetch on B

t2  Caller B: coordinator.awaitCompletion(...)  // returns B.donePromise

# A's CompletionRunner.run resolves -> A.resolveDone(metrics_A)
# A.donePromise resolves; B's prefetch unblocks
# Eventually B finishes; B.resolveDone(metrics_B)
```

Note: caller B's `prefetch()` does **not** return the promise — it returns
`void` like today. The `await previous` happens inside the method before
RunState_B is constructed. From the caller's perspective the timing of the
prefetch start shifts, but the contract is unchanged.

### Stats-refresh contract

`ChunkPhase.setOnComplete(cb)` retains current semantics — fires once after
streaming + initial chunk enrichment finishes for that phase instance.

`CompletionRunner.run()` gains a new behavior: after `CHUNK_BACKFILL_COMPLETE`
(step 7 in the existing pipeline), it invokes the same callback bound on
`ChunkPhase` a second time, passing the same `collectionName`.

The callback contract becomes:

> Called at most twice per run: once when chunk-streaming enrichment settles,
> and once when post-backfill chunk overlays settle. Both fire on success only;
> errors in the callback are caught and logged (existing semantics). Listeners
> must be idempotent — the implementation in
> `IngestFacade.refreshStatsByCollection` already is (alias resolution +
> `statsCache.save` overwrite).

The 896f343c invariant is preserved: the first fire still happens **after**
streaming work is awaited inside `ChunkPhase`. The second fire is a new event
that occurs strictly after the first.

### What actually changes per file

| File                               | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coordinator.ts`                   | Replace constructor singletons (`applier`, `filePhase`, `chunkPhase`, `backfiller`, `completion`) with a `createRunState()` factory called from `prefetch()`. Keep `markerStore`, `recovery` as singletons. Add `currentRun: RunState \| null`. Serialize `prefetch()` on `currentRun?.donePromise`. `awaitCompletion()` returns `currentRun?.donePromise` or `EMPTY_METRICS`. `onChunkEnrichmentComplete` setter binds the callback into the active or upcoming `RunState.chunkPhase`. |
| `completion-runner.ts`             | After `CHUNK_BACKFILL_COMPLETE`, invoke the bound `onComplete` callback again with `collectionName`. Catch+log errors as today.                                                                                                                                                                                                                                                                                                                                                         |
| `applier.ts`                       | No changes. Per-run lifetime is enforced externally now.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `file-phase.ts` / `chunk-phase.ts` | No structural changes. Per-run instances are created by `createRunState()`. The `bindChunkPhase()` wiring inside `FilePhase` is now done at factory time.                                                                                                                                                                                                                                                                                                                               |
| Tests                              | New test for: (a) two sequential `prefetch()` calls, second sees no missed paths from first; (b) concurrent `prefetch()` calls, second waits for first to resolve; (c) stats callback fires twice for a run with backfilled paths. Existing tests should still pass — public API unchanged.                                                                                                                                                                                             |

### Error handling

- If the first run's `donePromise` rejects, the second `prefetch()` continues
  (`.catch(() => undefined)`) — failure of run A must not block run B.
- If `createRunState()` throws (e.g. provider mis-configured), `currentRun`
  stays at the previous value if the new run never installed itself.
- Callback errors in either fire site are caught and logged as today; the
  pipeline continues.

### Testing

| Layer                       | Test                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Unit — coordinator          | `prefetch()` twice sequentially: applier.missedFiles in second run starts at 0     |
| Unit — coordinator          | `prefetch()` concurrent: second resolves only after first; metrics are independent |
| Unit — completion-runner    | `onComplete` invoked twice when backfill produces overlays; once when no backfill  |
| Integration — ingest-facade | Full reindex + concurrent incremental: stats cache reflects post-backfill counts   |
| Existing tests              | Must still pass; public API unchanged                                              |

The integration test for stats refresh is the load-bearing one — it demonstrates
the user-visible bug (filesWithGitData=5 vs 22459) being fixed.

## Risks

- **Per-run garbage** — each run allocates fresh applier/filePhase/chunkPhase
  instances. These are small (a few maps). Force reindex creates exactly one
  RunState; long-running daemons see one allocation per reindex trigger
  (typically every few minutes at most). Negligible.
- **FIFO latency** — incremental reindex during a 50-min force reindex now waits
  up to 50 min before applying. Acceptable: the file changes are still picked up
  on the next sync trigger after force completes, and the alternative (race
  writes to Qdrant) is worse. If UX feedback later demands isolated parallel
  runs, the `RunState` shape already supports that future change (Map<runId,
  RunState>) without re-architecting.
- **Callback double-fire** — listeners that are not idempotent could
  double-process. `IngestFacade.refreshStatsByCollection` is idempotent today.
  The contract change is documented in the callback's JSDoc; any future listener
  must respect it.
- **896f343c regression** — neutralized by design: the first callback fire still
  awaits streaming work inside `ChunkPhase`; the second fire is strictly later
  and additive.

## Migration & Rollout

No data migration required — `RunState` is in-memory only. No Qdrant payload or
marker schema changes. Rolls out as a regular code change. No feature flag
needed; the behavior change is scoped to the enrichment internals and observable
only through corrected metrics + stats.

## Open Questions

None at design time. All architectural decisions taken; remaining choices
(naming of `RunState` factory method, exact placement of the second callback
fire inside `CompletionRunner`) belong to the implementation plan.
