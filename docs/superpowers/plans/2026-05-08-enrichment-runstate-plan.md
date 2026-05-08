# Enrichment RunState — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (NOT `superpowers:executing-plans`) and `dinopowers:test-driven-development`
> (NOT `superpowers:test-driven-development`) for the failing-test-first phases.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate stale enrichment state across reindex runs by introducing a
per-run `RunState` container in `EnrichmentCoordinator`, serializing concurrent
`prefetch()` calls FIFO, and re-firing the stats-refresh callback after backfill
— without regressing the 896f343c streaming-completion contract or changing the
`enrichment/` public API.

**Architecture:** Coordinator transitions from "constructor-built singletons +
per-call init" to "per-run factory + bounded state container". A `RunState`
struct binds a fresh `EnrichmentApplier` + `FilePhase` + `ChunkPhase` +
`EnrichmentBackfiller` + `CompletionRunner` + provider contexts + donePromise
per `prefetch()` call. Old in-flight promise closures from a previous run mutate
their own (now-orphaned) `RunState` and have zero effect on the current run.
`markerStore` and `recovery` stay singletons (no per-run state). `prefetch()`
awaits the previous run's `donePromise` before constructing a new `RunState`.
`CompletionRunner.run()` invokes the bound chunk-phase `onComplete` callback a
second time after `CHUNK_BACKFILL_COMPLETE`.

**Tech Stack:** TypeScript (strict), vitest, lint-staged (prettier + tsc
pre-commit). Target: `src/core/domains/ingest/pipeline/enrichment/`.

**Spec:** `docs/superpowers/specs/2026-05-08-enrichment-runstate-design.md`
(commit `d11fa3cd`). Read before drafting any change.

**Beads epic:** `tea-rags-mcp-89pc` (already exists, P1, labels: `bugfix`,
`architecture`).

---

## Affected Files (tea-rags impact enrichment, rerank: imports+churn+ownership)

| File                                                                      | Owner (blame)                             | Churn                 | Age | Bugs               | Tasks                    |
| ------------------------------------------------------------------------- | ----------------------------------------- | --------------------- | --- | ------------------ | ------------------------ |
| `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`              | Arthur 70% (2 contributors — same person) | 16 commits **high**   | 0d  | bugFixRate **44%** | 1, 2                     |
| `src/core/domains/ingest/pipeline/enrichment/completion-runner.ts`        | Arthur 100% solo                          | 1 commit (post-split) | 0d  | —                  | 3                        |
| `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts`              | Arthur 100% solo                          | 2 commits             | 0d  | —                  | 3                        |
| `src/core/domains/ingest/pipeline/enrichment/file-phase.ts`               | Arthur 100% solo                          | 2 commits             | 0d  | —                  | (consumed, not modified) |
| `tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`       | (existing, 1712 lines)                    | —                     | —   | —                  | 1, 2                     |
| `tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts` | (existing)                                | —                     | —   | —                  | 3                        |

**High-blast-radius file:** `coordinator.ts` is imported by `IngestFacade` and
other pipeline wiring. Public API stays frozen for all 3 Tasks (constructor
signature,
`prefetch`/`onChunksStored`/`startChunkEnrichment`/`awaitCompletion`/`runRecovery`
shapes, `onChunkEnrichmentComplete` setter all unchanged).

**Coordinated change pair:** `coordinator.ts` (Task 1: RunState factory) +
`completion-runner.ts` (Task 3: second callback fire). Tasks 1+2 ship before
Task 3; Task 3 depends on `RunState.chunkPhase` already being per-run so the
second fire targets the right instance.

**Out of scope (do NOT modify):**

- `applier.ts` — per-spec lifetime is enforced externally; the class itself is
  untouched
- `recovery.ts` — Non-Goal in spec, solo-owner zone, separate concern
- `marker-store.ts` — singleton, no changes
- `enrichment/index.ts` barrel — public API stable per Constraint #2
- `tea-rags-mcp-qdrv` (60s backfill timeout) — Non-Goal in spec, separate epic
  concern

---

## Beads Tracking — link plan Tasks to existing beads issues

After plan is committed, run these to wire plan ↔ beads:

```bash
bd dolt pull
# Update beads task scope to match resolved spec approach
bd update tea-rags-mcp-d2y5 \
  --title="Per-run RunState container in EnrichmentCoordinator" \
  --description="Spec docs/superpowers/specs/2026-05-08-enrichment-runstate-design.md resolved 'reset applier' as 'per-run RunState' (Option B). Plan Task 1: build createRunState() factory; coordinator.ts replaces constructor singletons with per-run instances; old promise closures mutate orphaned RunState. Eliminates Bug #1 (zombie missedFiles=488 across 6 incremental reindexes)."
# Add explicit ordering: Task 2 depends on Task 1, Task 3 depends on Task 1
bd dep add tea-rags-mcp-c33r tea-rags-mcp-d2y5
bd dep add tea-rags-mcp-sr33 tea-rags-mcp-d2y5
```

---

## Task 1 — Per-run RunState container

**Beads:** `tea-rags-mcp-d2y5` (P1, labels: `bugfix`, `architecture`).

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` (entire
  class body — singleton fields → per-run factory)
- Test: `tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts` (add
  new `describe` block)

**Why:** Bug #1 — `EnrichmentApplier.matchedFiles`, `missedFiles`,
`_missedFileChunks` are instance fields on a singleton instantiated once in the
coordinator constructor. Two sequential `prefetch()` calls share the same
applier; the second backfill sees zombie missed paths from the first. Fix by
creating a fresh applier per `prefetch()` call, owned by a `RunState` container.

- [ ] **Step 1.1: Mark beads task in_progress**

```bash
bd update tea-rags-mcp-d2y5 --status=in_progress
```

- [ ] **Step 1.2: Write the failing test for state isolation between sequential
      runs**

Append to `tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`:

```typescript
describe("EnrichmentCoordinator — RunState isolation", () => {
  let mockQdrant: any;
  let provider: EnrichmentProvider;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    provider = {
      key: "git",
      signals: [],
      filters: [],
      presets: [],
      resolveRoot: vi.fn((p: string) => p),
      // First run: 1 path in fileMetadata, 1 path missed (causes missedFiles to grow)
      buildFileSignals: vi
        .fn()
        .mockResolvedValue(new Map([["matched.ts", { commitCount: 1 }]])),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
  });

  it("does not leak missedFileChunks between sequential prefetch calls", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, provider);

    // Run 1 — apply a batch where one chunk has no matching fileMetadata.
    coordinator.prefetch("/repo", "test-col");
    coordinator.onChunksStored("test-col", "/repo", [
      {
        chunkId: "c1",
        chunk: {
          metadata: { filePath: "/repo/missed.ts" },
          startLine: 1,
          endLine: 5,
        } as any,
      },
    ]);
    await coordinator.awaitCompletion("test-col");

    // Run 2 — fresh prefetch. Apply the SAME missed path.
    // Bug: shared applier still has _missedFileChunks["missed.ts"] from run 1,
    // so backfill in run 2 attempts both run 1's zombie AND run 2's new entry.
    // Fix: per-run applier sees missed.ts as a single new entry.
    coordinator.prefetch("/repo", "test-col");
    coordinator.onChunksStored("test-col", "/repo", [
      {
        chunkId: "c2",
        chunk: {
          metadata: { filePath: "/repo/missed.ts" },
          startLine: 1,
          endLine: 5,
        } as any,
      },
    ]);
    await coordinator.awaitCompletion("test-col");

    // Run 2's backfill must see exactly ONE missed path (its own), not two.
    // Verifying via buildFileSignals call: backfill calls it with { paths: missedPaths }
    const backfillCalls = (provider.buildFileSignals as any).mock.calls.filter(
      (c: any[]) => c[1]?.paths !== undefined,
    );
    // Run 2's backfill (the second backfill call) should pass exactly ["missed.ts"]
    expect(backfillCalls.length).toBeGreaterThanOrEqual(1);
    const lastBackfillPaths = backfillCalls[backfillCalls.length - 1][1].paths;
    expect(lastBackfillPaths).toEqual(["missed.ts"]);
    expect(lastBackfillPaths).not.toContain("missed.ts" /* from run 1 */); // i.e. no duplicate
    expect(lastBackfillPaths.length).toBe(1);
  });
});
```

- [ ] **Step 1.3: Run failing test to confirm it fails on current code**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts -t "does not leak missedFileChunks"
```

Expected: FAIL — `lastBackfillPaths.length` is 1 by accident (the single key
collapses) OR the call count differs. If the test passes by coincidence on
current code, strengthen it: add `applier.missedFiles` exposure check via
reflection on the second run only, or replicate two distinct missed paths to
verify the leak directly. Adjust until test reliably fails on `main` and passes
after Step 1.5.

- [ ] **Step 1.4: Replace coordinator.ts with per-run RunState factory**

Replace the entire body of
`src/core/domains/ingest/pipeline/enrichment/coordinator.ts`:

```typescript
/**
 * EnrichmentCoordinator — generic timing orchestrator for enrichment providers.
 *
 * Coordinates three phases per provider:
 * 1. Prefetch: provider.buildFileSignals (fire-and-forget at T=0) — owned by FilePhase
 * 2. Per-batch: apply file signals as chunks arrive — owned by FilePhase
 * 3. Streaming + post-flush chunk overlays — owned by ChunkPhase
 *
 * Per-run state is bounded inside a `RunState` container. Each `prefetch()`
 * builds a fresh RunState; old promise closures from previous runs mutate
 * their own (now-orphaned) RunState and have zero effect on the current run.
 */

import { randomUUID } from "node:crypto";

import type { Ignore } from "ignore";

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import type { ChunkLookupEntry, EnrichmentMetrics } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import { EnrichmentApplier } from "./applier.js";
import { EnrichmentBackfiller } from "./backfiller.js";
import { ChunkPhase } from "./chunk-phase.js";
import { CompletionRunner } from "./completion-runner.js";
import { FilePhase } from "./file-phase.js";
import { EnrichmentMarkerStore } from "./marker-store.js";
import type { EnrichmentRecovery } from "./recovery.js";
import type { EnrichmentProvider, ProviderContext } from "./types.js";

const EMPTY_METRICS: EnrichmentMetrics = {
  prefetchDurationMs: 0,
  overlapMs: 0,
  overlapRatio: 0,
  streamingApplies: 0,
  flushApplies: 0,
  chunkChurnDurationMs: 0,
  totalDurationMs: 0,
  matchedFiles: 0,
  missedFiles: 0,
  missedPathSamples: [],
  gitLogFileCount: 0,
  estimatedSavedMs: 0,
};

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

export class EnrichmentCoordinator {
  private readonly markerStore: EnrichmentMarkerStore;
  private currentRun: RunState | null = null;
  private readonly providers: EnrichmentProvider[];
  private _onChunkEnrichmentComplete?: (
    collectionName: string,
  ) => Promise<void>;

  get onChunkEnrichmentComplete():
    | ((collectionName: string) => Promise<void>)
    | undefined {
    return this._onChunkEnrichmentComplete;
  }
  set onChunkEnrichmentComplete(
    cb: ((collectionName: string) => Promise<void>) | undefined,
  ) {
    this._onChunkEnrichmentComplete = cb;
    if (cb && this.currentRun) this.currentRun.chunkPhase.setOnComplete(cb);
  }

  get providerKeys(): string[] {
    return this.providers.map((p) => p.key);
  }

  constructor(
    private readonly qdrant: QdrantManager,
    providers: EnrichmentProvider | EnrichmentProvider[],
    private readonly recovery?: EnrichmentRecovery,
  ) {
    this.markerStore = new EnrichmentMarkerStore(qdrant);
    this.providers = Array.isArray(providers) ? providers : [providers];
  }

  async runRecovery(
    collectionName: string,
    absolutePath: string,
  ): Promise<void> {
    if (!this.recovery) return;
    // Recovery uses a transient context map seeded from providers (no persistent
    // RunState needed — recovery completes synchronously per collection).
    const contexts = new Map<string, ProviderContext>(
      this.providers.map((p) => [
        p.key,
        { key: p.key, provider: p, effectiveRoot: null, ignoreFilter: null },
      ]),
    );
    await this.recovery.recoverAll(
      collectionName,
      absolutePath,
      contexts,
      this.markerStore,
    );
  }

  prefetch(
    absolutePath: string,
    collectionName?: string,
    ignoreFilter?: Ignore,
    changedPaths?: string[],
  ): void {
    // Build a fresh RunState. Per-run instances guarantee old promise closures
    // mutate their orphaned RunState, never the current one.
    const runState = this.createRunState();
    this.currentRun = runState;

    // Bind the existing onComplete callback (if any) to this run's chunkPhase.
    if (this._onChunkEnrichmentComplete) {
      runState.chunkPhase.setOnComplete(this._onChunkEnrichmentComplete);
    }

    // Resolve provider contexts.
    runState.contexts = new Map(
      this.providers.map((provider) => {
        const effectiveRoot = provider.resolveRoot(absolutePath);
        if (effectiveRoot !== absolutePath) {
          pipelineLog.enrichmentPhase("REPO_ROOT_DIFFERS", {
            provider: provider.key,
            absolutePath,
            effectiveRoot,
          });
        }
        return [
          provider.key,
          {
            key: provider.key,
            provider,
            effectiveRoot,
            ignoreFilter: ignoreFilter ?? null,
          },
        ];
      }),
    );

    runState.filePhase.init(
      runState.contexts,
      collectionName ?? "",
      runState.runId,
      runState.startedAt,
    );
    runState.chunkPhase.init(
      runState.contexts,
      collectionName ?? "",
      runState.startedAt,
    );

    if (collectionName) {
      void this.markerStore.markStart(
        collectionName,
        [...runState.contexts.keys()],
        runState.runId,
        runState.startedAt,
      );
    }

    runState.filePhase.startPrefetch(changedPaths);
  }

  onChunksStored(
    collectionName: string,
    absolutePath: string,
    items: ChunkItem[],
  ): void {
    if (!this.currentRun) return;
    this.currentRun.filePhase.onBatch(collectionName, absolutePath, items);
    this.currentRun.chunkPhase.onBatch(collectionName, absolutePath, items);
  }

  startChunkEnrichment(
    collectionName: string,
    absolutePath: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): void {
    if (!this.currentRun) return;
    this.currentRun.chunkPhase.enrichRemaining(
      collectionName,
      absolutePath,
      chunkMap,
    );
  }

  async awaitCompletion(collectionName: string): Promise<EnrichmentMetrics> {
    const run = this.currentRun;
    if (!run || run.contexts.size === 0) return EMPTY_METRICS;
    try {
      const metrics = await run.completion.run(
        collectionName,
        run.contexts,
        run.startTime,
        async (coll, providerKey, level) =>
          this.countSettledUnenriched(coll, providerKey, level),
        run.startedAt,
      );
      run.resolveDone(metrics);
      return metrics;
    } catch (error) {
      run.rejectDone(error);
      throw error;
    }
  }

  private createRunState(): RunState {
    const applier = new EnrichmentApplier(this.qdrant);
    const chunkPhase = new ChunkPhase(applier);
    const filePhase = new FilePhase(applier, this.markerStore);
    filePhase.bindChunkPhase(chunkPhase);
    const backfiller = new EnrichmentBackfiller(applier, this.qdrant);
    const completion = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: this.markerStore,
    });

    let resolveDone!: (m: EnrichmentMetrics) => void;
    let rejectDone!: (e: unknown) => void;
    const donePromise = new Promise<EnrichmentMetrics>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    return {
      runId: randomUUID().slice(0, 8),
      startTime: Date.now(),
      startedAt: new Date().toISOString(),
      applier,
      filePhase,
      chunkPhase,
      backfiller,
      completion,
      contexts: new Map(),
      donePromise,
      resolveDone,
      rejectDone,
    };
  }

  private async countSettledUnenriched(
    collectionName: string,
    providerKey: string,
    level: "file" | "chunk",
  ): Promise<number> {
    if (!this.recovery) return 0;
    const first = await this.recovery
      .countUnenriched(collectionName, providerKey, level)
      .catch(() => 0);
    if (first === 0) return 0;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await this.recovery
      .countUnenriched(collectionName, providerKey, level)
      .catch(() => first);
  }
}
```

- [ ] **Step 1.5: Run new failing test to verify it now passes**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts -t "does not leak missedFileChunks"
```

Expected: PASS.

- [ ] **Step 1.6: Run full coordinator test suite to verify no regressions**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts
```

Expected: ALL existing 1712-line test suite passes. Pay attention to:

- `EnrichmentCoordinator — onChunkEnrichmentComplete callback` (lines 537-697) —
  must still pass; the setter now binds to `currentRun.chunkPhase`
- `EnrichmentCoordinator — recovery integration` (lines 1275-1402) —
  `runRecovery` no longer uses `this.contexts`; verify the synthesized contexts
  map preserves test expectations
- `EnrichmentCoordinator — runRecovery stale-marker protection` (lines 1564+) —
  same check

If any test fails, do NOT weaken it. Inspect the divergence — most likely a test
inspected the old `coordinator.contexts` field that no longer exists. Update the
test to use a public observable (e.g. provider invocations) instead of internal
state.

- [ ] **Step 1.7: Run full enrichment test directory**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/
```

Expected: ALL pass.

- [ ] **Step 1.8: Type-check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 1.9: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/coordinator.ts \
        tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts
git commit -m "$(cat <<'EOF'
fix(enrichment)!: per-run RunState container in EnrichmentCoordinator

Replaces constructor-built singleton applier/filePhase/chunkPhase/
backfiller/completion with a per-run factory. Each prefetch() builds
a fresh RunState; old promise closures from prior runs mutate their
own orphaned RunState and have zero effect on the current run.

Eliminates Bug #1 (zombie missedFiles=488 across 6 incremental
reindexes in production-rails-app — pipeline-2026-05-06T13-44-15.log) by giving
each run its own EnrichmentApplier with fresh _missedFileChunks
and matchedFiles/missedFiles counters.

Public API of enrichment/ unchanged (constructor, prefetch,
onChunksStored, startChunkEnrichment, awaitCompletion, runRecovery,
onChunkEnrichmentComplete setter). Spec:
docs/superpowers/specs/2026-05-08-enrichment-runstate-design.md.

Beads: tea-rags-mcp-d2y5 (epic tea-rags-mcp-89pc).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 1.10: Close beads task**

```bash
bd close tea-rags-mcp-d2y5
```

---

## Task 2 — FIFO serialize concurrent prefetch

**Beads:** `tea-rags-mcp-c33r` (P1, labels: `bugfix`, `architecture`).

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`
  (`prefetch()` body — add serialize gate)
- Test: `tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts` (add
  new test in same describe block)

**Why:** Bug #2 — even with per-run RunState (Task 1), if `prefetch()` is called
while a previous run is still in-flight, the second call installs `currentRun`
immediately, while the previous run's `awaitCompletion` may still resolve its
`donePromise` later, racing with the new run's writes to Qdrant on overlapping
chunkIds. FIFO serialization at the `prefetch()` entry point eliminates the
race: a new prefetch waits for the previous run's `donePromise` to settle before
constructing `RunState_new`.

- [ ] **Step 2.1: Mark beads task in_progress**

```bash
bd update tea-rags-mcp-c33r --status=in_progress
```

- [ ] **Step 2.2: Write the failing test for FIFO serialization**

Append to the same `EnrichmentCoordinator — RunState isolation` describe block
in `coordinator.test.ts`:

```typescript
it("serializes concurrent prefetch calls FIFO behind the previous run's donePromise", async () => {
  let resolveFirstBuild!: (value: Map<string, any>) => void;
  const firstBuildPromise = new Promise<Map<string, any>>((r) => {
    resolveFirstBuild = r;
  });
  const buildFileSignalsCalls: string[] = [];
  const slowProvider: EnrichmentProvider = {
    ...provider,
    buildFileSignals: vi.fn().mockImplementation((root: string) => {
      buildFileSignalsCalls.push(root);
      // First call resolves only when test signals; subsequent calls resolve immediately.
      return buildFileSignalsCalls.length === 1
        ? firstBuildPromise
        : Promise.resolve(new Map());
    }),
  };
  const coordinator = new EnrichmentCoordinator(mockQdrant, slowProvider);

  // Run 1 — start, but its prefetch promise is held open.
  coordinator.prefetch("/repo-1", "test-col");
  const completion1 = coordinator.awaitCompletion("test-col");

  // Run 2 — call prefetch while Run 1's prefetch is still pending.
  // FIFO contract: Run 2 must NOT call provider.buildFileSignals until Run 1 completes.
  coordinator.prefetch("/repo-2", "test-col");

  // Give microtasks a chance to run; Run 2 must still be queued.
  await Promise.resolve();
  await Promise.resolve();
  expect(buildFileSignalsCalls).toEqual(["/repo-1"]); // Run 2 has NOT started yet

  // Now release Run 1.
  resolveFirstBuild(new Map());
  await completion1;
  // Allow Run 2's awaited prefetch to proceed and the next microtask cycle.
  await new Promise((r) => setTimeout(r, 10));

  // Run 2 must have started by now.
  expect(buildFileSignalsCalls).toEqual(["/repo-1", "/repo-2"]);
});
```

- [ ] **Step 2.3: Run failing test to confirm it fails on Task 1 code**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts -t "serializes concurrent prefetch"
```

Expected: FAIL — Task 1's `prefetch()` synchronously installs the new RunState
and starts buildFileSignals immediately; the test sees `["/repo-1", "/repo-2"]`
after the first `await Promise.resolve()`.

- [ ] **Step 2.4: Add serialize gate to prefetch()**

Modify `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`:

Replace the existing `prefetch()` method body opening with:

```typescript
  prefetch(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore, changedPaths?: string[]): void {
    // FIFO serialize: queue this run's setup behind the previous run's donePromise.
    // The public signature stays `void`; queuing happens via an internal promise
    // chain stored in this.currentRun. Callers don't await; they get
    // FIFO ordering for free on the in-flight side.
    const previousDone = this.currentRun?.donePromise;

    // Pre-construct the new RunState's done promise so we can swap currentRun
    // immediately and have awaitCompletion attach to the right run.
    const runState = this.createRunState();
    this.currentRun = runState;

    if (this._onChunkEnrichmentComplete) {
      runState.chunkPhase.setOnComplete(this._onChunkEnrichmentComplete);
    }

    void (async () => {
      // Wait for the previous run to settle before initializing this one.
      // Catch — failure of run N must not block run N+1.
      if (previousDone) {
        await previousDone.catch(() => undefined);
      }

      runState.contexts = new Map(
        this.providers.map((provider) => {
          const effectiveRoot = provider.resolveRoot(absolutePath);
          if (effectiveRoot !== absolutePath) {
            pipelineLog.enrichmentPhase("REPO_ROOT_DIFFERS", {
              provider: provider.key,
              absolutePath,
              effectiveRoot,
            });
          }
          return [
            provider.key,
            {
              key: provider.key,
              provider,
              effectiveRoot,
              ignoreFilter: ignoreFilter ?? null,
            },
          ];
        }),
      );

      runState.filePhase.init(runState.contexts, collectionName ?? "", runState.runId, runState.startedAt);
      runState.chunkPhase.init(runState.contexts, collectionName ?? "", runState.startedAt);

      if (collectionName) {
        void this.markerStore.markStart(
          collectionName,
          [...runState.contexts.keys()],
          runState.runId,
          runState.startedAt,
        );
      }

      runState.filePhase.startPrefetch(changedPaths);
    })();
  }
```

**Critical caveat to handle:** `onChunksStored` and `startChunkEnrichment` may
be invoked AFTER `prefetch()` returns but BEFORE the queued setup completes.
Callers expect them to enqueue (not silently drop). Update both methods:

```typescript
  onChunksStored(collectionName: string, absolutePath: string, items: ChunkItem[]): void {
    if (!this.currentRun) return;
    // FilePhase/ChunkPhase have their own pending-batch buffers (pendingBatches,
    // ready flag) that already handle "init not yet complete" by queuing. The
    // contexts being empty pre-init is the only blocker — once contexts populate
    // inside the queued IIFE, init() runs and drains.
    this.currentRun.filePhase.onBatch(collectionName, absolutePath, items);
    this.currentRun.chunkPhase.onBatch(collectionName, absolutePath, items);
  }
```

If `onBatch` accesses `this.contexts` before `init()` runs, the existing
buffering logic in `file-phase.ts` covers the gap (`pendingBatches`). But
`chunkPhase.onBatch` requires `markPrefetchPending` to have been called via
`filePhase.startPrefetch`. To make this robust, prepend a guard in
`chunk-phase.ts:onBatch` that checks `states.size === 0` (init not run yet) and
falls into the existing pendingBatches buffer. Verify this is already the case —
`chunk-phase.ts:onBatch` reads from `this.states.get(ctx.key)` which returns
undefined → no-op when init hasn't run. **This is a silent drop.** Fix:

If, when reviewing chunk-phase.ts, the `init()` precondition is required for
batching to enqueue: extend `awaitCompletion` to call init implicitly the first
time, OR delay `onChunksStored`/`startChunkEnrichment` calls until contexts
populate. The cleanest fix: have `prefetch()` perform the synchronous parts
(createRunState, set currentRun, init filePhase+chunkPhase with empty contexts
that get re-init'd inside the IIFE) BEFORE the IIFE awaits previousDone. Then
the IIFE just calls `startPrefetch`.

Adjusted `prefetch()`:

```typescript
  prefetch(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore, changedPaths?: string[]): void {
    const previousDone = this.currentRun?.donePromise;

    const runState = this.createRunState();
    this.currentRun = runState;

    if (this._onChunkEnrichmentComplete) {
      runState.chunkPhase.setOnComplete(this._onChunkEnrichmentComplete);
    }

    // Resolve contexts and init phases synchronously so onChunksStored /
    // startChunkEnrichment calls that arrive between prefetch() and the
    // queued startPrefetch enqueue into the correct (current) RunState.
    runState.contexts = new Map(
      this.providers.map((provider) => {
        const effectiveRoot = provider.resolveRoot(absolutePath);
        if (effectiveRoot !== absolutePath) {
          pipelineLog.enrichmentPhase("REPO_ROOT_DIFFERS", {
            provider: provider.key,
            absolutePath,
            effectiveRoot,
          });
        }
        return [
          provider.key,
          {
            key: provider.key,
            provider,
            effectiveRoot,
            ignoreFilter: ignoreFilter ?? null,
          },
        ];
      }),
    );

    runState.filePhase.init(runState.contexts, collectionName ?? "", runState.runId, runState.startedAt);
    runState.chunkPhase.init(runState.contexts, collectionName ?? "", runState.startedAt);

    if (collectionName) {
      void this.markerStore.markStart(
        collectionName,
        [...runState.contexts.keys()],
        runState.runId,
        runState.startedAt,
      );
    }

    // Defer ONLY the actual provider buildFileSignals call behind the
    // previous run's donePromise. Init is synchronous; serialization is on
    // the prefetch promise resolution.
    void (async () => {
      if (previousDone) {
        await previousDone.catch(() => undefined);
      }
      runState.filePhase.startPrefetch(changedPaths);
    })();
  }
```

This preserves init() ordering and only serializes the actual
`provider.buildFileSignals` call.

- [ ] **Step 2.5: Run failing test to verify it now passes**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts -t "serializes concurrent prefetch"
```

Expected: PASS.

- [ ] **Step 2.6: Run Task 1's isolation test to verify still green**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts -t "RunState isolation"
```

Expected: PASS.

- [ ] **Step 2.7: Run full coordinator test suite**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts
```

Expected: ALL pass. The streaming-completion lifecycle test
(`onChunkEnrichmentComplete callback` describe block) deserves special attention
— it asserts the callback fires after streaming work settles. With Task 2's
serialize gate the timing changes slightly; if any test relied on synchronous
prefetch behavior, adjust to use `await` properly.

- [ ] **Step 2.8: Type-check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 2.9: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/coordinator.ts \
        tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts
git commit -m "$(cat <<'EOF'
fix(enrichment): FIFO serialize concurrent prefetch in EnrichmentCoordinator

A new prefetch() now defers provider.buildFileSignals behind the
previous run's donePromise. Init (createRunState + filePhase.init +
chunkPhase.init + markerStore.markStart) stays synchronous so
onChunksStored/startChunkEnrichment calls between prefetch() and the
queued buildFileSignals enqueue into the correct (current) RunState.

Eliminates Bug #2 (incremental reindex during in-flight force corrupts
final ALL_COMPLETE metrics — pipeline-2026-05-07T15-03-02.log shows
prefetchDurationMs=1640 borrowed from incremental in a force run that
processed 22459+7262 files).

896f343c streaming-completion contract preserved: ChunkPhase still
awaits streaming work before firing onChunkEnrichmentComplete.

Beads: tea-rags-mcp-c33r (epic tea-rags-mcp-89pc).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2.10: Close beads task**

```bash
bd close tea-rags-mcp-c33r
```

---

## Task 3 — Second callback fire after CHUNK_BACKFILL_COMPLETE

**Beads:** `tea-rags-mcp-sr33` (P2, labels: `bugfix`).

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts` (add
  `fireOnComplete()` public method)
- Modify: `src/core/domains/ingest/pipeline/enrichment/completion-runner.ts`
  (invoke after step 7 if backfill ran)
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` (update
  JSDoc on `onChunkEnrichmentComplete` setter)
- Test:
  `tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts` (new
  test)

**Why:** Downstream effect — `StatsCache` freezes pre-backfill because
`onChunkEnrichmentComplete` fires once when ChunkPhase finishes streaming +
initial chunk enrichment, then `CompletionRunner.run()` writes 7000+ overlays
via backfill, but no second stats refresh fires. Production: production-rails-app force
reindex completes with 22459+7262 enriched files in Qdrant but
`get_index_metrics` reports `filesWithGitData=5`. Fix: re-fire the same callback
after `CHUNK_BACKFILL_COMPLETE` (step 7 in CompletionRunner). Listeners
(currently `IngestFacade.refreshStatsByCollection`) are already idempotent.

- [ ] **Step 3.1: Mark beads task in_progress**

```bash
bd update tea-rags-mcp-sr33 --status=in_progress
```

- [ ] **Step 3.2: Add `fireOnComplete()` public method to ChunkPhase**

Modify `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts`. After the
`setOnComplete()` method (around line 86), add:

```typescript
  /**
   * Manually invoke the bound onComplete callback. Used by CompletionRunner to
   * fire a second stats-refresh after backfill writes file-level overlays.
   * No-op if no callback is bound. Errors are caught and logged (same semantics
   * as the streaming-end fire site).
   */
  async fireOnComplete(coll: string): Promise<void> {
    const cb = this.onComplete;
    if (!cb) return;
    try {
      await cb(coll);
    } catch (error) {
      console.error("[Enrichment] onChunkEnrichmentComplete (post-backfill) callback failed:", error);
    }
  }
```

- [ ] **Step 3.3: Wire second fire into CompletionRunner**

Modify `src/core/domains/ingest/pipeline/enrichment/completion-runner.ts`. Track
whether backfill produced any overlays, then fire after step 7 if so:

Replace the `run()` method body. Key changes:

1. Track `backfillOccurred` flag in step 3.
2. After step 7's `for...of` loop (after `markChunkFinal`), if
   `backfillOccurred`, await `chunkPhase.fireOnComplete(coll)`.

```typescript
  async run(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    startTime: number,
    unenrichedReader?: UnenrichedReader,
    runStartedAt = "",
  ): Promise<EnrichmentMetrics> {
    const { filePhase, chunkPhase, backfiller, applier, markerStore } = this.deps;
    const readUnenriched: UnenrichedReader = unenrichedReader ?? (async () => 0);

    // 1. drain prefetch
    await filePhase.awaitPrefetch();

    // 2. drain fileWork
    await filePhase.drain();

    // 3. backfill per ctx
    let backfillOccurred = false;
    if (applier.getMissedFileChunks().size > 0) {
      backfillOccurred = true;
      for (const ctx of contexts.values()) {
        if (filePhase.hasPrefetchFailed(ctx.key)) continue;
        await backfiller.runFor(coll, ctx, runStartedAt);
      }
    }

    // 4. markFileFinal per ctx
    for (const ctx of contexts.values()) {
      const fileUnenriched = await readUnenriched(coll, ctx.key, "file");
      await markerStore.markFileFinal(coll, ctx.key, {
        status: filePhase.hasPrefetchFailed(ctx.key) ? "failed" : "completed",
        durationMs: filePhase.getPrefetchDurationMs(ctx.key),
        unenrichedChunks: fileUnenriched,
        matchedFiles: applier.matchedFiles,
        missedFiles: applier.missedFiles,
      });
    }

    // 5. aggregate metrics (unchanged)
    const fileMetrics = filePhase.getMetrics();
    const chunkMetrics = chunkPhase.getMetrics();
    const metrics: EnrichmentMetrics = {
      prefetchDurationMs: fileMetrics.maxPrefetchDurationMs,
      overlapMs: 0,
      overlapRatio: 0,
      streamingApplies: fileMetrics.totalStreamingApplies,
      flushApplies: fileMetrics.totalFlushApplies,
      chunkChurnDurationMs: chunkMetrics.totalChunkEnrichmentDurationMs,
      totalDurationMs: Date.now() - (startTime || Date.now()),
      matchedFiles: applier.matchedFiles,
      missedFiles: applier.missedFiles,
      missedPathSamples: [...applier.missedPathSamples],
      gitLogFileCount: fileMetrics.totalFileMetadataCount,
      estimatedSavedMs: 0,
    };
    const first = fileMetrics.firstProvider;
    if (first && first.prefetchEndTime > 0 && first.pipelineFlushTime > 0) {
      const overlapEnd = Math.min(first.prefetchEndTime, first.pipelineFlushTime);
      metrics.overlapMs = Math.max(0, overlapEnd - first.prefetchStartTime);
      metrics.overlapRatio =
        metrics.prefetchDurationMs > 0 ? Math.min(1, metrics.overlapMs / metrics.prefetchDurationMs) : 0;
    }
    metrics.estimatedSavedMs = Math.max(0, metrics.overlapMs);

    // 6. drain chunkWork
    await chunkPhase.drain();
    const finalChunkMetrics = chunkPhase.getMetrics();
    metrics.chunkChurnDurationMs = finalChunkMetrics.totalChunkEnrichmentDurationMs;

    // 7. markChunkFinal per ctx
    for (const ctx of contexts.values()) {
      const chunkUnenriched = await readUnenriched(coll, ctx.key, "chunk");
      let chunkStatus: ChunkFinalInput["status"];
      if (filePhase.hasPrefetchFailed(ctx.key) || chunkPhase.hasChunkEnrichmentFailed(ctx.key)) {
        chunkStatus = "failed";
      } else if (chunkUnenriched > 0) {
        chunkStatus = "degraded";
      } else {
        chunkStatus = "completed";
      }
      await markerStore.markChunkFinal(coll, ctx.key, {
        status: chunkStatus,
        durationMs: finalChunkMetrics.totalChunkEnrichmentDurationMs,
        unenrichedChunks: chunkUnenriched,
      });
    }

    // 8. Re-fire stats callback if backfill wrote post-streaming overlays.
    // First fire (streaming end inside ChunkPhase) is preserved; this is a
    // strictly-later second fire so listeners (StatsCache) reflect post-backfill
    // state. Callback contract documents idempotency.
    if (backfillOccurred) {
      await chunkPhase.fireOnComplete(coll);
    }

    pipelineLog.enrichmentPhase("ALL_COMPLETE", { ...metrics });
    return metrics;
  }
```

- [ ] **Step 3.4: Update JSDoc on coordinator setter**

In `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`, replace the
JSDoc above `onChunkEnrichmentComplete` getter (around lines 60-65) with:

```typescript
/**
 * Optional callback fired after enrichment milestones. Invoked at most twice
 * per run:
 * 1. After ChunkPhase streaming + initial chunk enrichment settles.
 * 2. After CompletionRunner finishes file backfill + chunk backfill (only
 *    when backfill produced overlays).
 *
 * Both fires receive the collectionName. Errors in the callback are caught
 * and logged — they do not affect enrichment. Listeners must be idempotent
 * (e.g. IngestFacade.refreshStatsByCollection overwrites stats cache, so a
 * second call simply supersedes the first).
 *
 * 896f343c contract preserved: the first fire still awaits streaming work
 * inside ChunkPhase before invoking the callback.
 */
```

- [ ] **Step 3.5: Write the failing test for double-fire**

Append to
`tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts` (read
existing top of file first to match its setup conventions):

```typescript
describe("CompletionRunner — onComplete double-fire after backfill", () => {
  it("fires chunkPhase.onComplete a second time when backfill produces overlays", async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);

    // Build a CompletionRunner with mocks that simulate: missed files exist,
    // backfill runs, fireOnComplete is invoked.
    const applier = {
      matchedFiles: 5,
      missedFiles: 2,
      missedPathSamples: ["a.ts", "b.ts"],
      getMissedFileChunks: vi.fn().mockReturnValue(
        new Map([
          ["a.ts", []],
          ["b.ts", []],
        ]),
      ),
    } as any;
    const filePhase = {
      awaitPrefetch: vi.fn().mockResolvedValue(undefined),
      drain: vi.fn().mockResolvedValue(undefined),
      hasPrefetchFailed: vi.fn().mockReturnValue(false),
      getPrefetchDurationMs: vi.fn().mockReturnValue(100),
      getMetrics: vi.fn().mockReturnValue({
        maxPrefetchDurationMs: 100,
        totalStreamingApplies: 1,
        totalFlushApplies: 0,
        totalFileMetadataCount: 5,
        firstProvider: null,
      }),
    } as any;
    const chunkPhase = {
      drain: vi.fn().mockResolvedValue(undefined),
      hasChunkEnrichmentFailed: vi.fn().mockReturnValue(false),
      getMetrics: vi
        .fn()
        .mockReturnValue({ totalChunkEnrichmentDurationMs: 50 }),
      fireOnComplete: vi
        .fn()
        .mockImplementation(async (coll: string) => onComplete(coll)),
    } as any;
    const backfiller = {
      runFor: vi.fn().mockResolvedValue(undefined),
    } as any;
    const markerStore = {
      markFileFinal: vi.fn().mockResolvedValue(undefined),
      markChunkFinal: vi.fn().mockResolvedValue(undefined),
    } as any;

    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore,
    });
    const contexts = new Map([
      [
        "git",
        {
          key: "git",
          provider: {} as any,
          effectiveRoot: "/repo",
          ignoreFilter: null,
        },
      ],
    ]);

    await runner.run("test-col", contexts, Date.now());

    // Backfill ran (missed > 0), so fireOnComplete must be called exactly once.
    expect(chunkPhase.fireOnComplete).toHaveBeenCalledTimes(1);
    expect(chunkPhase.fireOnComplete).toHaveBeenCalledWith("test-col");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire chunkPhase.onComplete second time when backfill is skipped", async () => {
    const applier = {
      matchedFiles: 10,
      missedFiles: 0,
      missedPathSamples: [],
      getMissedFileChunks: vi.fn().mockReturnValue(new Map()), // empty — no backfill
    } as any;
    const filePhase = {
      awaitPrefetch: vi.fn().mockResolvedValue(undefined),
      drain: vi.fn().mockResolvedValue(undefined),
      hasPrefetchFailed: vi.fn().mockReturnValue(false),
      getPrefetchDurationMs: vi.fn().mockReturnValue(100),
      getMetrics: vi.fn().mockReturnValue({
        maxPrefetchDurationMs: 100,
        totalStreamingApplies: 1,
        totalFlushApplies: 0,
        totalFileMetadataCount: 10,
        firstProvider: null,
      }),
    } as any;
    const chunkPhase = {
      drain: vi.fn().mockResolvedValue(undefined),
      hasChunkEnrichmentFailed: vi.fn().mockReturnValue(false),
      getMetrics: vi
        .fn()
        .mockReturnValue({ totalChunkEnrichmentDurationMs: 50 }),
      fireOnComplete: vi.fn(),
    } as any;
    const backfiller = { runFor: vi.fn() } as any;
    const markerStore = {
      markFileFinal: vi.fn().mockResolvedValue(undefined),
      markChunkFinal: vi.fn().mockResolvedValue(undefined),
    } as any;

    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore,
    });
    const contexts = new Map([
      [
        "git",
        {
          key: "git",
          provider: {} as any,
          effectiveRoot: "/repo",
          ignoreFilter: null,
        },
      ],
    ]);

    await runner.run("test-col", contexts, Date.now());

    expect(backfiller.runFor).not.toHaveBeenCalled();
    expect(chunkPhase.fireOnComplete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3.6: Run failing test to verify intentional fail before
      implementation**

If Steps 3.2-3.4 are already applied (they are in this plan ordering), the test
should PASS. If not yet applied, the test would FAIL with
`chunkPhase.fireOnComplete is not a function`. Verify the test runs:

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts -t "onComplete double-fire"
```

Expected: PASS (after Steps 3.2-3.4).

- [ ] **Step 3.7: Run full enrichment test directory**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/
```

Expected: ALL pass. Existing `chunk-phase.test.ts` may need a tiny update if it
checked the absence of public methods on ChunkPhase — `fireOnComplete` is new
but additive.

- [ ] **Step 3.8: Type-check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3.9: Build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 3.10: Request MCP reconnect for integration test**

This project IS an MCP server. After modifying `src/`, the running tea-rags MCP
server still holds the old code. Use `AskUserQuestion`:

```
question: "MCP server code was modified. Please reconnect the tea-rags MCP server to load the new code, then select 'Done' to continue testing."
options: [
  { label: "Done", description: "I've reconnected the MCP server" },
  { label: "Skip", description: "Skip integration testing — unit tests are sufficient for this task" }
]
```

- [ ] **Step 3.11: Integration test — full reindex + verify stats reflect
      post-backfill state**

Only if user selected "Done" in Step 3.10:

```
mcp__tea-rags__index_codebase path="/Users/artk0re/Dev/Tools/tea-rags-mcp" forceReindex=true
# Wait for completion (poll get_index_status until enrichment.git.chunk.status=completed)
mcp__tea-rags__get_index_metrics path="/Users/artk0re/Dev/Tools/tea-rags-mcp"
```

Expected: `filesWithGitData` matches the actual count of git-tracked files (not
5 — the production bug symptom).

- [ ] **Step 3.12: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts \
        src/core/domains/ingest/pipeline/enrichment/completion-runner.ts \
        src/core/domains/ingest/pipeline/enrichment/coordinator.ts \
        tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts
git commit -m "$(cat <<'EOF'
fix(stats): re-fire onChunkEnrichmentComplete after backfill

CompletionRunner.run() now invokes chunkPhase.fireOnComplete(coll) a
second time after CHUNK_BACKFILL_COMPLETE when backfill produced
overlays. ChunkPhase exposes fireOnComplete() as a thin public method
that invokes the bound callback with the same try/catch semantics as
the streaming-end fire site.

Eliminates StatsCache freeze observed in production-rails-app force reindex
(filesWithGitData=5 reported despite Qdrant having 22459+7262 enriched
files). The first fire (streaming end) preserves the 896f343c
contract; the second fire is strictly later and additive.

Listeners must be idempotent — IngestFacade.refreshStatsByCollection
already is (alias resolution + statsCache.save overwrite).

Beads: tea-rags-mcp-sr33 (epic tea-rags-mcp-89pc).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3.13: Close beads task and epic**

```bash
bd close tea-rags-mcp-sr33
# Epic tea-rags-mcp-89pc remains open until tea-rags-mcp-qdrv (60s timeout) is also closed.
# The plan does not address qdrv — leave it open.
```

---

## Verification — Final State

After all 3 Tasks committed:

- [ ] **Step V.1: Run full test suite**

```bash
npx vitest run
```

Expected: ALL pass.

- [ ] **Step V.2: Type-check + lint**

```bash
npx tsc --noEmit
npx eslint src tests
```

Expected: clean.

- [ ] **Step V.3: Verify beads epic state**

```bash
bd show tea-rags-mcp-89pc
bd list --status=open --label=bugfix
```

Expected: tea-rags-mcp-d2y5, tea-rags-mcp-c33r, tea-rags-mcp-sr33 all closed;
tea-rags-mcp-qdrv remains open (deferred).

- [ ] **Step V.4: Push (per session-completion.md, ONLY after explicit user
      request)**

```bash
# DO NOT auto-push. Confirm with user first.
git status
git log --oneline -4
# Wait for user "push" command before running:
# git pull --rebase && git push
```

---

## Self-Review Notes

**Spec coverage check:**

- Bug #1 (applier state leak) — Task 1 ✓
- Bug #2 (concurrent prefetch) — Task 2 ✓
- Downstream StatsCache freeze — Task 3 ✓
- Constraint #1 (896f343c) — preserved (first callback fire untouched, second is
  strictly later)
- Constraint #2 (public API stable) — coordinator constructor + 6 public
  methods + setter unchanged
- Constraint #3 (re-entrant pipeline) — Task 2 queues, never rejects
- Constraint #4 (no sentinels) — only promise chain, no timers/heartbeats
- Goal: stats refresh after full lifecycle — Task 3 ✓

**Out-of-scope respected:**

- applier.ts unchanged ✓
- recovery.ts unchanged ✓
- marker-store.ts unchanged ✓
- enrichment/index.ts barrel unchanged ✓
- qdrv (60s timeout) excluded ✓

**Type consistency:** RunState shape consistent across Tasks 1, 2, 3.
`fireOnComplete()` is the only new public symbol on ChunkPhase. No renaming.

**Edge cases handled:**

- First fire still awaits streaming work (296f343c contract)
- Second fire only when backfill ran (no spurious double-fire on no-op backfill)
- Callback errors caught + logged (existing pattern)
- Previous run failure does not block next run (`.catch(() => undefined)`)
- onChunksStored/startChunkEnrichment between prefetch() and queued
  buildFileSignals: synchronous init covers the gap

---

## Execution

Plan complete. To execute task-by-task:

```
Skill(dinopowers:executing-plans) with this plan path
```

Or for inline execution with TDD discipline per Task:

```
Skill(dinopowers:test-driven-development) per Task's failing-test step
```
