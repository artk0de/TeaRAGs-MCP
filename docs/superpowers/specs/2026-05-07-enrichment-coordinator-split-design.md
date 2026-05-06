# Refactor: EnrichmentCoordinator — Component Split

## Problem

`src/core/domains/ingest/pipeline/enrichment/coordinator.ts` is 980 lines and
holds a single `EnrichmentCoordinator` class that owns six unrelated
responsibilities. The agent (and humans) make recurring mistakes editing this
file because every method touches three or four of those responsibilities at
once.

tea-rags signals confirm `coordinator.ts` is the worst place to keep this much
context together:

- File-level: `bugFixRate=47%` (concerning), `commitCount=15` high,
  `recencyWeightedFreq=2.46` burst, `changeDensity=8.77` active.
- Hot symbols inside the file:
  - `runRecovery` (lines 200–247) — `bugFixRate=55`, `relativeChurn=5.57` high
  - `awaitCompletion` (lines 443–592) — 138-line method, `commitCount=8` extreme
  - `updateEnrichmentMarker` (lines 651–692) — `bugFixRate=42`,
    `relativeChurn=4.02` high
  - `flushPendingBatches` (lines 706–738) — recent burst
- Neighbours:
  - `recovery.ts:scrollUnenriched` — `bugFixRate=70` critical
  - `applier.ts:85-228` — 95-line block, `bugFixRate=58` concerning,
    `churnVolatility=9.08`

Both neighbours are deep silos with one author, so refactoring their internals
is high-risk. They must be **isolated behind interfaces**, not rewritten.

The six responsibilities currently glued together in `EnrichmentCoordinator`:

1. **Lifecycle / per-run state** — `runId`, `runStartedAt`, `startTime`,
   `Map<providerKey, ProviderState>`, metrics aggregation. `ProviderState` is a
   god-struct with 21 fields (timers + prefetch result + buffered batches +
   work-tracking + counters + flags).
2. **Marker persistence** — deep-merge writes to
   `payload.enrichment.<provider>.{file,chunk}` at five distinct moments
   scattered across `prefetch`, `prefetch.catch`, `runRecovery`, and two stages
   of `awaitCompletion`. This is the hottest source of bugs ("forgot to write
   the marker", "marker overwritten by stale path").
3. **Phase 1: file prefetch** — fire `provider.buildFileSignals` per-provider in
   parallel with the rest of the pipeline.
4. **Phase 2a: per-batch file-signal apply** — react to each `onChunksStored`
   event; if prefetch isn't ready yet, buffer the batch and drain via
   `prefetch.then()`.
5. **Phase 2b: chunk-signal enrichment** — streaming (per-batch) and post-flush
   catch-up; share a `Semaphore(10)` across both; the same "build → apply →
   mark" skeleton is duplicated between `startStreamingChunkEnrichment` and
   `startChunkEnrichment`.
6. **Recovery & backfill** — `runRecovery` wraps `EnrichmentRecovery` with a
   race-guard; `backfillMissedFiles` + `backfillChunkSignals` close the loop for
   files prefetch missed entirely (state lives on `EnrichmentApplier`, fix logic
   lives in `EnrichmentCoordinator` — a smell).

Each responsibility's state pollutes `ProviderState`, so any edit to one
responsibility has visibility into nine fields belonging to other
responsibilities. That is the root cause of the agent's recurring mistakes.

## Solution

Split `EnrichmentCoordinator` into **5 new components + a slim Coordinator
façade**. Public API of the coordinator stays identical (no caller changes
upstream). All risky internals (`applier.applyFileSignals`,
`recovery.recoverFileLevel`, `recovery.recoverChunkLevel`, the
`scrollUnenriched` query) remain untouched — they gain narrow accessors only.

### Component diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                EnrichmentCoordinator (façade, ~150 lines)          │
│   prefetch()  onChunksStored()  startChunkEnrichment()             │
│   runRecovery()  awaitCompletion()                                 │
│   ─── pure wiring + Map<key, ProviderContext> + runId ───          │
└──┬───────────┬──────────┬───────────┬─────────────┬────────────────┘
   ▼           ▼          ▼           ▼             ▼
MarkerStore  FilePhase  ChunkPhase  Backfiller  CompletionRunner
                            │           │
                            └─── reads ─┘
                                  ▼
                          EnrichmentApplier
                          (existing, +2 accessors)

                          EnrichmentRecovery
                          (existing, +recoverAll() entry point)
```

### State decomposition: `ProviderState` → 3 narrow types

| New type          | Lifetime          | Owner                   | Fields                                                                                                                                                                                                                        |
| ----------------- | ----------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProviderContext` | per-run, readonly | `EnrichmentCoordinator` | `key`, `provider`, `effectiveRoot`, `ignoreFilter`                                                                                                                                                                            |
| `FilePhaseState`  | per-run, mutable  | `FilePhase` (private)   | `prefetchPromise`, `fileMetadata`, `prefetchFailed`, `pendingBatches`, `fileWork`, `prefetchStartTime`, `prefetchEndTime`, `pipelineFlushTime`, `prefetchDurationMs`, `streamingApplies`, `flushApplies`, `fileMetadataCount` |
| `ChunkPhaseState` | per-run, mutable  | `ChunkPhase` (private)  | `chunkWork`, `streamingEnrichedFiles`, `chunkEnrichmentDurationMs`, `chunkEnrichmentFailed`, `chunkEnrichmentInvoked`                                                                                                         |

`ProviderContext` is computed once by the coordinator inside `prefetch()` and
passed to each phase as a read-only `Map<string, ProviderContext>`. Phases never
share state with each other.

### 1. `EnrichmentMarkerStore` — `marker-store.ts` (NEW)

Owns the `payload.enrichment` record on `INDEXING_METADATA_ID`. Five
domain-specific write methods replace the single generic
`updateEnrichmentMarker` plus its scattered call-sites.

```typescript
interface FileFinalInput {
  status: "completed" | "failed";
  durationMs: number;
  unenrichedChunks: number;
  matchedFiles: number;
  missedFiles: number;
}

interface ChunkFinalInput {
  status: "completed" | "degraded" | "failed";
  durationMs: number;
  unenrichedChunks: number;
}

interface RecoveryResultInput {
  fileStatus: "completed" | "failed";
  fileUnenriched: number;
  chunkStatus: "completed" | "degraded" | "failed";
  chunkUnenriched: number;
}

class EnrichmentMarkerStore {
  constructor(qdrant: QdrantManager) {}

  async markStart(
    coll: string,
    providerKeys: Iterable<string>,
    runId: string,
    startedAt: string,
  ): Promise<void>;

  async markPrefetchFailed(
    coll: string,
    providerKey: string,
    runId: string,
    startedAt: string,
    durationMs: number,
  ): Promise<void>;

  async markRecoveryResult(
    coll: string,
    providerKey: string,
    input: RecoveryResultInput,
  ): Promise<void>;

  async markFileFinal(
    coll: string,
    providerKey: string,
    input: FileFinalInput,
  ): Promise<void>;

  async markChunkFinal(
    coll: string,
    providerKey: string,
    input: ChunkFinalInput,
  ): Promise<void>;

  async read(coll: string): Promise<Record<string, unknown> | null>;

  async getRunId(
    coll: string,
    providerKey: string,
  ): Promise<string | undefined>;
}
```

Internals: deep-merge per provider key, error logging via
`pipelineLog.enrichmentPhase("MARKER_UPDATE_FAILED", ...)`. The
`ProviderMarkerUpdate` type and `updateEnrichmentMarker` method disappear
entirely.

### 2. `FilePhase` — `file-phase.ts` (NEW)

Owns prefetch, per-batch file-signal apply, and `pendingBatches` drain. Has its
own private `Map<string, FilePhaseState>`.

```typescript
interface FilePhaseMetrics {
  maxPrefetchDurationMs: number;
  totalStreamingApplies: number;
  totalFlushApplies: number;
  totalFileMetadataCount: number;
  // overlap timing source for awaitCompletion
  firstProvider: {
    prefetchStartTime: number;
    prefetchEndTime: number;
    pipelineFlushTime: number;
  } | null;
}

class FilePhase {
  constructor(
    applier: EnrichmentApplier,
    markerStore: EnrichmentMarkerStore,
    pipelineLog: typeof pipelineLog,
  ) {}

  /** Initialize per-run state. Call once before prefetch. */
  init(
    contexts: Map<string, ProviderContext>,
    coll: string,
    runId: string,
    runStartedAt: string,
  ): void;

  /** Fire prefetch promises in parallel. Non-blocking. */
  startPrefetch(changedPaths?: string[]): void;

  /** Per-batch reaction. Drains pendingBatches if prefetch already ready. */
  onBatch(coll: string, absolutePath: string, items: ChunkItem[]): void;

  /** Wait until all prefetch promises settle. */
  awaitPrefetch(): Promise<void>;

  /** Wait until all in-flight applyFileSignals finish. */
  drain(): Promise<void>;

  hasPrefetchFailed(providerKey: string): boolean;

  getMetrics(): FilePhaseMetrics;

  /** Read-only access for Backfiller/CompletionRunner. */
  getEffectiveRoot(providerKey: string): string | null;
  getPrefetchDurationMs(providerKey: string): number;
}
```

The `prefetch.then()` callback inside `FilePhase` calls
`markerStore.markPrefetchFailed(...)` on error. No marker logic leaks to the
coordinator.

### 3. `ChunkPhase` — `chunk-phase.ts` (NEW)

Owns streaming chunk enrichment, post-flush catch-up, and the shared
`Semaphore(10)`. Eliminates duplication between `startStreamingChunkEnrichment`
and `startChunkEnrichment` via a private helper.

```typescript
interface ChunkPhaseMetrics {
  totalChunkEnrichmentDurationMs: number;
}

class ChunkPhase {
  constructor(applier: EnrichmentApplier, pipelineLog: typeof pipelineLog) {}

  init(
    contexts: Map<string, ProviderContext>,
    coll: string,
    runStartedAt: string,
  ): void;

  /** Streaming entry: per-batch, fire-and-forget. */
  onBatch(coll: string, absolutePath: string, items: ChunkItem[]): void;

  /** Post-flush catch-up: enrich files that streaming missed. */
  enrichRemaining(
    coll: string,
    absolutePath: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): void;

  drain(): Promise<void>;

  hasChunkEnrichmentFailed(providerKey: string): boolean;

  getMetrics(): ChunkPhaseMetrics;

  setOnComplete(cb: (coll: string) => Promise<void>): void;
}
```

Private helper `runChunkSignals(ctx, coll, root, chunkMap, useSemaphore)` is
shared by `onBatch` and `enrichRemaining`. The `streamingEnrichedFiles` set
lives in `ChunkPhaseState`; `enrichRemaining` consults it for de-dup.

### 4. `EnrichmentBackfiller` — `backfiller.ts` (NEW)

Single closed loop: read missed files from Applier → fetch overlays via provider
→ apply → update applier counters.

```typescript
class EnrichmentBackfiller {
  constructor(
    applier: EnrichmentApplier,
    qdrant: QdrantManager,
    pipelineLog: typeof pipelineLog,
  ) {}

  async runFor(
    coll: string,
    ctx: ProviderContext,
    runStartedAt: string,
  ): Promise<void>;
}
```

`EnrichmentApplier` gains two narrow methods (its hot internals stay untouched):

```typescript
class EnrichmentApplier {
  // ... existing methods unchanged ...

  /** Read-only snapshot of files whose chunks landed without file metadata. */
  getMissedFileChunks(): ReadonlyMap<string, MissedFileChunk[]>;

  /** Update matched/missed counters after a successful backfill. */
  markBackfilled(count: number): void;
}
```

### 5. `CompletionRunner` — `completion-runner.ts` (NEW)

Owns the 7-step finalization sequence. Receives all collaborators in the
constructor. Single public method.

```typescript
class CompletionRunner {
  constructor(deps: {
    filePhase: FilePhase;
    chunkPhase: ChunkPhase;
    backfiller: EnrichmentBackfiller;
    applier: EnrichmentApplier;
    markerStore: EnrichmentMarkerStore;
    pipelineLog: typeof pipelineLog;
  }) {}

  async run(
    coll: string,
    contexts: Map<string, ProviderContext>,
    startTime: number,
  ): Promise<EnrichmentMetrics>;
}
```

Internal sequence (each step 3–5 lines):

1. `await filePhase.awaitPrefetch()`
2. `await filePhase.drain()`
3. `for ctx in contexts: await backfiller.runFor(coll, ctx, ...)`
4. `for ctx in contexts: await markerStore.markFileFinal(coll, ctx.key, ...)`
5. Build `EnrichmentMetrics` from
   `filePhase.getMetrics() + chunkPhase.getMetrics() + applier counters`
6. `await chunkPhase.drain()`
7. `for ctx in contexts: await markerStore.markChunkFinal(coll, ctx.key, ...)`

### 6. `EnrichmentCoordinator` — `coordinator.ts` (slimmed, ~150–180 lines)

Pure wiring + façade. No business logic.

```typescript
export class EnrichmentCoordinator {
  private contexts: Map<string, ProviderContext> = new Map();
  private runId = "";
  private runStartedAt = "";
  private startTime = 0;

  private readonly markerStore: EnrichmentMarkerStore;
  private readonly applier: EnrichmentApplier;
  private readonly filePhase: FilePhase;
  private readonly chunkPhase: ChunkPhase;
  private readonly backfiller: EnrichmentBackfiller;
  private readonly completion: CompletionRunner;

  constructor(
    qdrant: QdrantManager,
    private readonly providers: EnrichmentProvider[],
    private readonly recovery?: EnrichmentRecovery,
  ) {
    this.applier = new EnrichmentApplier(qdrant);
    this.markerStore = new EnrichmentMarkerStore(qdrant);
    this.filePhase = new FilePhase(this.applier, this.markerStore, pipelineLog);
    this.chunkPhase = new ChunkPhase(this.applier, pipelineLog);
    this.backfiller = new EnrichmentBackfiller(
      this.applier,
      qdrant,
      pipelineLog,
    );
    this.completion = new CompletionRunner({
      filePhase: this.filePhase,
      chunkPhase: this.chunkPhase,
      backfiller: this.backfiller,
      applier: this.applier,
      markerStore: this.markerStore,
      pipelineLog,
    });
  }

  get providerKeys(): string[] {
    return this.providers.map((p) => p.key);
  }

  set onChunkEnrichmentComplete(cb: (coll: string) => Promise<void>) {
    this.chunkPhase.setOnComplete(cb);
  }

  prefetch(
    absolutePath: string,
    coll?: string,
    ignoreFilter?: Ignore,
    changedPaths?: string[],
  ): void {
    this.startTime = Date.now();
    this.runId = randomUUID().slice(0, 8);
    this.runStartedAt = new Date().toISOString();
    this.contexts = new Map(
      this.providers.map((p) => [
        p.key,
        {
          key: p.key,
          provider: p,
          effectiveRoot: p.resolveRoot(absolutePath),
          ignoreFilter: ignoreFilter ?? null,
        },
      ]),
    );

    if (coll) {
      void this.markerStore.markStart(
        coll,
        this.contexts.keys(),
        this.runId,
        this.runStartedAt,
      );
    }

    this.filePhase.init(
      this.contexts,
      coll ?? "",
      this.runId,
      this.runStartedAt,
    );
    this.chunkPhase.init(this.contexts, coll ?? "", this.runStartedAt);
    this.filePhase.startPrefetch(changedPaths);
  }

  onChunksStored(coll: string, absolutePath: string, items: ChunkItem[]): void {
    this.filePhase.onBatch(coll, absolutePath, items);
    this.chunkPhase.onBatch(coll, absolutePath, items);
  }

  startChunkEnrichment(
    coll: string,
    absolutePath: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): void {
    this.chunkPhase.enrichRemaining(coll, absolutePath, chunkMap);
  }

  async runRecovery(coll: string, absolutePath: string): Promise<void> {
    if (!this.recovery) return;
    await this.recovery.recoverAll(
      coll,
      absolutePath,
      this.contexts,
      this.markerStore,
    );
  }

  async awaitCompletion(coll: string): Promise<EnrichmentMetrics> {
    if (this.contexts.size === 0) return EMPTY_METRICS;
    return this.completion.run(coll, this.contexts, this.startTime);
  }
}
```

### `EnrichmentRecovery` — minimal addition

Add one high-level entry that owns the race-guard previously in
`Coordinator.runRecovery`:

```typescript
class EnrichmentRecovery {
  // ... existing recoverFileLevel, recoverChunkLevel, scrollUnenriched, countUnenriched unchanged ...

  async recoverAll(
    coll: string,
    absolutePath: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    markerStore: EnrichmentMarkerStore,
  ): Promise<void>;
}
```

The 95-line `applier.applyFileSignals` and the `bugFixRate=70 critical`
`scrollUnenriched` are not modified.

## Public API

`EnrichmentCoordinator`'s public surface stays identical:

- Constructor: `(qdrant, providers, recovery?)` — unchanged
- `providerKeys` getter — unchanged
- `onChunkEnrichmentComplete` setter — unchanged behaviour, delegated to
  ChunkPhase
- `prefetch(absolutePath, coll?, ignoreFilter?, changedPaths?)` — unchanged
- `onChunksStored(coll, absolutePath, items)` — unchanged
- `startChunkEnrichment(coll, absolutePath, chunkMap)` — unchanged
- `runRecovery(coll, absolutePath)` — unchanged
- `awaitCompletion(coll)` — unchanged

`IngestFacade`, `BaseIndexingPipeline`, and any tests that import
`EnrichmentCoordinator` continue to compile without modification.

## File Layout

Flat under `src/core/domains/ingest/pipeline/enrichment/`:

```
enrichment/
  index.ts                  (existing — barrel: only Coordinator + DTOs)
  coordinator.ts            (existing — slimmed to ~180 lines)
  types.ts                  (existing — adds ProviderContext, FilePhaseMetrics, ChunkPhaseMetrics, FileFinalInput, ChunkFinalInput, RecoveryResultInput)
  applier.ts                (existing — adds getMissedFileChunks() + markBackfilled())
  recovery.ts               (existing — adds recoverAll())
  health-mapper.ts          (existing — untouched)
  marker-store.ts           ← NEW
  file-phase.ts             ← NEW
  chunk-phase.ts            ← NEW
  backfiller.ts             ← NEW
  completion-runner.ts      ← NEW
  trajectory/               (existing — untouched)
```

Tests mirror under `tests/core/domains/ingest/pipeline/enrichment/`. Each new
component gets its own test file with focused unit tests; existing
`tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts` is updated
to cover the slimmed façade.

## Migration Plan

Eight incremental tasks, each ends with a green `npx vitest run` and a working
`EnrichmentCoordinator`. No big-bang.

1. **MarkerStore extraction.** Create `marker-store.ts` with the seven methods.
   Replace all five marker-write call sites in `coordinator.ts` with the
   corresponding domain methods. `updateEnrichmentMarker` / `readExistingMarker`
   removed from the coordinator. Deep-merge logic moved verbatim. Tests: unit
   tests for each marker method (5 cases).
2. **Applier accessors + Backfiller extraction.** Add `getMissedFileChunks()`
   and `markBackfilled(count)` to `EnrichmentApplier`. Create `backfiller.ts`
   with `runFor(coll, ctx, runStartedAt)`. Coordinator's `backfillMissedFiles` /
   `backfillChunkSignals` reduced to a `backfiller.runFor(coll, ctx, ...)` call
   inside `awaitCompletion`. Tests: unit tests for the closed loop with a
   stubbed provider.
3. **`recoverAll` in EnrichmentRecovery.** Add the high-level entry that owns
   the race-guard and the final marker write. Coordinator's `runRecovery`
   becomes a one-liner. Tests: race-guard unit test (stale runId scenario).
4. **`ProviderContext` type + computation.** Introduce the type in `types.ts`.
   Coordinator computes `Map<string, ProviderContext>` inside `prefetch()` and
   stores it. Phase code still reads from the old `ProviderState` for now — this
   step is preparation only.
5. **ChunkPhase extraction.** Move `startChunkEnrichment` (catch-up) and
   `startStreamingChunkEnrichment` (streaming) into `ChunkPhase`. Move the
   shared `Semaphore(10)`. De-duplicate via a private `runChunkSignals` helper.
   `ProviderState`'s chunk-related fields move to `ChunkPhaseState`. Tests: unit
   tests for streaming dedup (no double-enrichment) and catch-up skip behaviour.
6. **FilePhase extraction.** Move `prefetch`, `onChunksStored` (file half), and
   `flushPendingBatches` into `FilePhase`. `ProviderState`'s prefetch/file
   fields move to `FilePhaseState`. The remaining `ProviderState` shrinks to
   just the names of fields each phase took. Tests: unit tests for
   buffered-batch drain and prefetch-failure marker write.
7. **CompletionRunner extraction.** Move `awaitCompletion` (138 lines) into
   `CompletionRunner.run(coll, contexts, startTime)`. Coordinator's
   `awaitCompletion` becomes a one-liner. Tests: unit tests for the 7-step
   sequence with stubbed phases.
8. **Coordinator finalization + barrel cleanup.** Delete
   `aggregateProviderMetrics` (moved into CompletionRunner). Delete
   `createProviderState` and the `ProviderState` interface (no longer used —
   replaced by `ProviderContext` + per-phase state). Update
   `enrichment/index.ts` barrel to export only `EnrichmentCoordinator` and
   public DTOs. Verify the public API hasn't drifted. Update existing
   `coordinator.test.ts` to test the slimmed façade.

After step 8, `coordinator.ts` is 150–180 lines, all six original
responsibilities have a single owner, and the agent's blast radius for any edit
shrinks from "everything in 980 lines" to "one focused file under 250 lines".

## Testing

- **Unit tests per component**: each new component (`MarkerStore`, `FilePhase`,
  `ChunkPhase`, `Backfiller`, `CompletionRunner`) gets a dedicated test file
  with mocked collaborators (Qdrant via `MockQdrantManager`, providers via stub
  objects).
- **Coordinator integration test** (existing `coordinator.test.ts`, updated):
  exercises the public API end-to-end with the real wiring of all five
  components. Verifies marker contents at each lifecycle moment (start →
  prefetch-failed / file-final → chunk-final).
- **Existing pipeline tests** (`tests/core/domains/ingest/pipeline/*`) must
  continue to pass without modification — they exercise `EnrichmentCoordinator`
  through `IngestFacade` and treat its public API as the contract.
- **Pre-commit hook** runs `npx vitest run` + type-check; every step must leave
  both green.

## Out of Scope

- `EnrichmentApplier` internal logic (`applyFileSignals` 95-line block,
  `bugFixRate=58`) — only narrow accessors added.
- `EnrichmentRecovery` internal queries (`scrollUnenriched`, `bugFixRate=70`
  critical) — only a `recoverAll` wrapper added.
- `health-mapper.ts` — not touched.
- `EnrichmentProvider` interface and trajectory/git provider implementations —
  not touched.
- Performance: no hot path changes; this is a structural refactor.
- Multi-provider missed-counter conflation in `EnrichmentApplier` (a known
  pre-existing issue) — out of scope for this refactor.
