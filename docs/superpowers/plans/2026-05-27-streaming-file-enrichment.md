# Streaming File Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. **Chaining:** invoke the `dinopowers:`
> wrappers (`dinopowers:executing-plans`, `dinopowers:test-driven-development`),
> NOT the raw `superpowers:` versions.

**Goal:** Make file-level enrichment stream per stored batch in parallel with
embedding (shared by git + codegraph), eliminating the whole-repo prefetch gate
and un-gating the already-streamable git chunk enrichment.

**Architecture:** Add two optional `EnrichmentProvider` methods —
`streamFileBatch` (per-batch, returns signals to apply now) and
`finalizeSignals` (once after the stream, returns deferred whole-graph signals).
The coordinator drives per-batch streaming via `onChunksStored` and a single
finalize pass via `CompletionRunner`. git streams file+chunk; codegraph streams
edge extraction and defers all its signals to finalize. Removing the gate
simplifies the deep-silo coordinator/chunk-phase hub.

**Tech Stack:** TypeScript, Vitest, Qdrant (`set_payload` nested-key writes),
DuckDB (codegraph graph store), `git cat-file --batch` /
`git blame --porcelain`.

**Spec:**
`docs/superpowers/specs/2026-05-27-streaming-file-enrichment-design.md`

> **AMENDMENT (2026-05-27):** codegraph chunk-signal deferral redesigned — see
> `docs/superpowers/specs/2026-05-27-codegraph-chunk-defer-design.md`.
> `finalizeSignals` is now **file-only**
> (`Promise<Map<string,FileSignalOverlay>>`, no `FinalizeResult`); codegraph
> defers CHUNK signals to an isolated post-finalize
> `ChunkPhase.runDeferredChunk` pass driven by a `defersChunkEnrichment`
> provider flag, reusing `buildChunkSignals` with the full chunkMap ChunkPhase
> accumulates. Tasks 1, 2, 3, 5, 7 are updated accordingly; where older task
> text conflicts, the amendment spec wins.

---

## Conventions for every Task

- **TDD:** RED test first (run it, watch it fail for the right reason), then
  minimal GREEN impl, then run green.
- **Test runner:** `npx vitest run <path>` (env from `tests/vitest.setup.ts`).
- **Business-logic / signal-value tests are immutable** — do not rewrite tests
  that assert computed signal VALUES. Only gate-mechanism tests
  (`markPrefetchPending` / `markReady` / `pendingBatches`) are rewritten, and
  the marker suites are EXTENDED.
- **Deep-silo commits** (`coordinator.ts`, `git/provider.ts`,
  `codegraph/symbols/provider.ts`, `applier.ts`, `marker-store.ts`,
  `completion-runner.ts`) MUST carry a `Why:` line — intent + trade-off
  (`.claude/rules/silo-pairing.md`).
- **Do NOT push** (ephemeral branch). Commit only; merge to main is a separate
  user-driven step.

## Shared type definitions (referenced by multiple Tasks)

Defined in Task 1; repeated here so out-of-order readers have them:

```ts
// src/core/contracts/types/provider.ts (AMENDED — file-only finalize)
// added to EnrichmentProvider (all OPTIONAL — fallback to buildFileSignals):
streamFileBatch?: (
  root: string,
  batchPaths: string[],
  options?: FileSignalOptions,
) => Promise<Map<string, FileSignalOverlay>>;
// finalize returns FILE overlays only; codegraph CHUNK signals are produced by
// the post-finalize ChunkPhase.runDeferredChunk pass (see amendment spec).
finalizeSignals?: (root: string, options?: FileSignalOptions) => Promise<Map<string, FileSignalOverlay>>;
// true ⇒ chunk signals need the finalized whole-graph; coordinator skips
// per-batch chunk dispatch and runs one buildChunkSignals pass post-finalize.
readonly defersChunkEnrichment?: boolean;
```

**Why optional + fallback:** keeps existing minimal provider-mock test fixtures
green (bounded blast radius). FilePhase calls
`provider.streamFileBatch ?? (r,p,o)=>provider.buildFileSignals(r,{...o,paths:p})`;
finalize is skipped when `finalizeSignals` is absent. `FinalizeResult` was
dropped (the chunk half was dead — codegraph chunk comes from the deferred pass,
not finalize).

---

## Task 1: Contract — `streamFileBatch` + `finalizeSignals`

**Files:**

- Modify: `src/core/contracts/types/provider.ts:134-189` (EnrichmentProvider) +
  add `FinalizeResult` near `FileSignalOverlay` (`:20-26`).
- Test: `tests/core/contracts/types/provider-contract.test.ts` (create).

- [ ] **Step 1: Write the failing test** — a structural test that a provider
      implementing the new optional methods type-checks and the result shape is
      a `{file, chunk}` pair of Maps.

```ts
// tests/core/contracts/types/provider-contract.test.ts
import { describe, expect, it } from "vitest";

import type {
  EnrichmentProvider,
  FinalizeResult,
} from "../../../../src/core/contracts/types/provider.js";

describe("EnrichmentProvider stream/finalize contract", () => {
  it("accepts a provider implementing streamFileBatch + finalizeSignals", async () => {
    const finalize: FinalizeResult = { file: new Map(), chunk: new Map() };
    const p: Pick<EnrichmentProvider, "streamFileBatch" | "finalizeSignals"> = {
      streamFileBatch: async () => new Map(),
      finalizeSignals: async () => finalize,
    };
    expect((await p.streamFileBatch!("/r", ["a.ts"])).size).toBe(0);
    const f = await p.finalizeSignals!("/r");
    expect(f.file).toBeInstanceOf(Map);
    expect(f.chunk).toBeInstanceOf(Map);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** —
      `npx vitest run tests/core/contracts/types/provider-contract.test.ts`
      Expected: TS error `FinalizeResult` / `streamFileBatch` not exported.

- [ ] **Step 3: Implement** — add to `provider.ts`:

```ts
/** Result of finalizeSignals — deferred whole-repo signals for both levels. */
export interface FinalizeResult {
  file: Map<string, FileSignalOverlay>;
  chunk: Map<string, Map<string, ChunkSignalOverlay>>;
}
```

and inside `interface EnrichmentProvider` (after `buildChunkSignals`):

```ts
  /**
   * Per-batch streaming file enrichment. Returns signals to apply immediately
   * for the given batch of repo-relative paths. Providers whose file signals
   * need the complete data set (codegraph graph metrics) return an empty map
   * and defer to finalizeSignals. Optional: when absent the coordinator falls
   * back to buildFileSignals({ paths: batchPaths }).
   */
  streamFileBatch?: (
    root: string,
    batchPaths: string[],
    options?: FileSignalOptions,
  ) => Promise<Map<string, FileSignalOverlay>>;
  /**
   * Deferred whole-repo finalize, run once after the embedding stream. Returns
   * signals that require the complete data set (e.g. graph SCC/PageRank).
   * Optional: providers that stream everything (git) omit it or return empty.
   */
  finalizeSignals?: (root: string, options?: FileSignalOptions) => Promise<FinalizeResult>;
```

- [ ] **Step 4: Run it, expect PASS.** Then `npx tsc --noEmit` (0 errors).

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/types/provider.ts tests/core/contracts/types/provider-contract.test.ts
git commit -m "feat(contracts): add streamFileBatch + finalizeSignals to EnrichmentProvider

Why: split whole-repo buildFileSignals into per-batch streaming + a deferred
finalize so file enrichment overlaps embedding. Optional methods keep existing
provider mocks green; foundation-only change, no runtime wiring yet."
```

---

## Task 2: git provider — `streamFileBatch` + empty `finalizeSignals`

**Files:**

- Modify: `src/core/domains/trajectory/git/provider.ts` (add two methods; keep
  `buildFileSignals` for backfill).
- Test: `tests/core/domains/trajectory/git/provider.test.ts` (extend; do not
  modify existing signal-value assertions).

git's `streamFileBatch(root, paths)` is the per-batch equivalent of
`buildFileSignals(root, {paths})` — it already computes per-path churn + blame
and returns overlays. `finalizeSignals` is empty (git streams everything).

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/core/domains/trajectory/git/provider.test.ts describe block
it("streamFileBatch delegates to per-path buildFileSignals for the batch", async () => {
  vi.mocked(nodeFs.existsSync).mockReturnValue(true);
  const data = new Map([["src/b.ts", { commits: [], recentAuthors: [] }]]);
  vi.mocked(buildFileSignalsForPaths).mockResolvedValue(data as never);
  const result = await provider.streamFileBatch!("/repo", ["src/b.ts"]);
  expect(buildFileSignalsForPaths).toHaveBeenCalledWith(
    "/repo",
    ["src/b.ts"],
    60000,
  );
  expect(result.has("src/b.ts")).toBe(true);
});

it("finalizeSignals returns empty file+chunk maps (git streams everything)", async () => {
  const f = await provider.finalizeSignals!("/repo");
  expect(f.file.size).toBe(0);
  expect(f.chunk.size).toBe(0);
});
```

- [ ] **Step 2: Run it, expect FAIL** —
      `npx vitest run tests/core/domains/trajectory/git/provider.test.ts`
      Expected: `provider.streamFileBatch is not a function`.

- [ ] **Step 3: Implement** — in `GitEnrichmentProvider`, add:

```ts
/** Per-batch streaming: same computation as buildFileSignals, scoped to the
 *  batch's paths. Populates blameByRelPath/lastFileResult for the batch so
 *  the matching buildChunkSignals call (same batch) sees per-range ownership. */
streamFileBatch = async (
  root: string,
  batchPaths: string[],
  options?: { collectionName?: string },
): Promise<Map<string, FileSignalOverlay>> => {
  return this.buildFileSignals(root, { paths: batchPaths, ...options });
};

/** git streams file+chunk signals per batch — nothing is deferred. */
finalizeSignals = async (): Promise<{
  file: Map<string, FileSignalOverlay>;
  chunk: Map<string, Map<string, ChunkSignalOverlay>>;
}> => ({ file: new Map(), chunk: new Map() });
```

(Use arrow-property style to match `fileSignalTransform`; import
`FinalizeResult` type if preferred over the inline shape.)

- [ ] **Step 4: Run it, expect PASS.** Then full git suite +
      `npx vitest run tests/core/domains/trajectory/git` and `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/git/provider.ts tests/core/domains/trajectory/git/provider.test.ts
git commit -m "feat(trajectory): git streamFileBatch + empty finalizeSignals

Why: git file/chunk signals are per-file independent, so streamFileBatch reuses
the per-path buildFileSignals path and finalize is a no-op. Trade-off: per-batch
git log instead of one whole-repo log, hidden under embedding overlap."
```

---

## Task 3: codegraph provider — run-sink lifecycle, stream extraction, finalize, leak fix

**Files:**

- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
  (`asExtractionSink` `:590-776`, `buildFileSignals` `:1051-1146`, run-global
  maps `:434` + `getRunMetrics` `:976-993`).
- Test: `tests/core/domains/trajectory/codegraph/symbols/provider.test.ts`
  (extend).

codegraph splits the current monolithic `buildFileSignals` into: a run-sink held
as run state, per-batch `streamFileBatch` (extract+write, return ∅), and
`finalizeSignals` (`sink.finish()` + read back file+chunk). Per-run maps are
cleared at finalize end.

- [ ] **Step 1: Write the failing test** — stream two batches, finalize, assert
      file+chunk signals returned AND run-state cleared.

```ts
// tests/core/domains/trajectory/codegraph/symbols/provider.test.ts (new cases)
it("streamFileBatch extracts and returns empty (signals deferred)", async () => {
  const r = await provider.streamFileBatch!(root, ["a.ts"], {
    collectionName: coll,
  });
  expect(r.size).toBe(0); // codegraph defers signals to finalize
});

it("finalizeSignals returns file+chunk signals after the graph settles", async () => {
  await provider.streamFileBatch!(root, ["a.ts"], { collectionName: coll });
  await provider.streamFileBatch!(root, ["b.ts"], { collectionName: coll });
  const f = await provider.finalizeSignals!(root, { collectionName: coll });
  expect(f.file.size).toBeGreaterThan(0);
  expect(f.chunk).toBeInstanceOf(Map);
});

it("clears chunkSymbolByLine for the collection after finalize (leak fix)", async () => {
  await provider.streamFileBatch!(root, ["a.ts"], { collectionName: coll });
  await provider.finalizeSignals!(root, { collectionName: coll });
  const map = (
    provider as unknown as {
      chunkSymbolByLine: Map<string, unknown>;
    }
  ).chunkSymbolByLine;
  expect(map.has(coll)).toBe(false);
});
```

(Reuse this test file's existing `root`/`coll`/store fixtures.)

- [ ] **Step 2: Run it, expect FAIL** —
      `npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider.test.ts`
      Expected: `streamFileBatch is not a function`.

- [ ] **Step 3a: Add run-sink state + helpers.** Introduce a per-collection run
      sink map and a finalize helper. Add fields near `chunkSymbolByLine`
      (`:434`):

```ts
  /** Active streaming sink per collection key. Created lazily by streamFileBatch,
   *  consumed + cleared by finalizeSignals. */
  private readonly runSinks = new Map<string, ExtractionSink>();
```

- [ ] **Step 3b: Implement `streamFileBatch`** — extract the batch's files into
      the (lazily created) run sink, return ∅:

```ts
streamFileBatch = async (
  root: string,
  batchPaths: string[],
  options?: FileSignalOptions,
): Promise<Map<string, FileSignalOverlay>> => {
  const key = this.collectionKey(options?.collectionName);
  let sink = this.runSinks.get(key);
  if (!sink) {
    sink = this.asExtractionSink(options?.collectionName);
    this.runSinks.set(key, sink);
  }
  const targets = batchPaths.filter(
    (p) =>
      SUPPORTED_EXTS.has(extensionOf(p)) &&
      !this.codegraphExclusionFilter.ignores(p),
  );
  for (const relPath of targets) {
    try {
      await sink.write(this.extractOneFile(root, relPath));
    } catch (err) {
      if (process.env.DEBUG === "true") {
        process.stderr.write(
          `[codegraph] skip ${relPath}: ${(err as Error).message}\n`,
        );
      }
    }
  }
  return new Map(); // signals deferred to finalizeSignals
};
```

- [ ] **Step 3c: Implement `finalizeSignals`** — finish the run sink (resolve +
      metrics), read back file+chunk overlays, clear run state. Extract the
      overlay-readback loop currently in `buildFileSignals:1106-1145` into a
      private `readFileOverlays(graphDb, paths)` and add `readChunkOverlays`
      mirroring `buildChunkSignals:1349+`:

```ts
finalizeSignals = async (
  root: string,
  options?: FileSignalOptions,
): Promise<FinalizeResult> => {
  const key = this.collectionKey(options?.collectionName);
  const sink = this.runSinks.get(key);
  const file = new Map<string, FileSignalOverlay>();
  const chunk = new Map<string, Map<string, ChunkSignalOverlay>>();
  try {
    if (sink) await sink.finish(); // streamingResolveAndUpsert + recomputeGraphMetricsStreaming
    const { graphDb } = await this.getStore(options?.collectionName);
    const paths = options?.paths ?? this.extractedRelPathsFor(key);
    await this.readFileOverlays(graphDb, paths, file);
    await this.readChunkOverlays(graphDb, paths, chunk);
  } finally {
    this.runSinks.delete(key);
    this.clearRunState(key); // chunkSymbolByLine + runAncestors/... for this collection
  }
  return { file, chunk };
};
```

Add `clearRunState(key)` that deletes `chunkSymbolByLine.get(key)` and resets
the `run*` maps (mirror the resets in `getRunMetrics:979-985,989-991`, but
scoped — `chunkSymbolByLine.delete(key)`). Track extracted paths per collection
(a `Set<string>` populated in `streamFileBatch`) for `extractedRelPathsFor`.

- [ ] **Step 3d:** Keep `buildFileSignals` unchanged (backfill/recovery still
      use it). It internally creates its own sink + finishes it — independent of
      the streaming run sink.

- [ ] **Step 4: Run it, expect PASS.** Then
      `npx vitest run tests/core/domains/trajectory/codegraph` and
      `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/provider.ts tests/core/domains/trajectory/codegraph/symbols/provider.test.ts
git commit -m "feat(trajectory): codegraph stream extraction + deferred finalizeSignals

Why: codegraph edge extraction is per-file (streams) but fanIn/PageRank/SCC need
the whole graph (deferred). Run-sink held as run state, finished in finalize;
run-global maps (chunkSymbolByLine et al.) cleared at finalize end — fixes the
monotonic chunkSymbolByLine leak on the long-lived daemon.
Trade-off: extraction overlaps embedding; SCC/PageRank stays one deferred pass."
```

---

## Task 4: FilePhase — remove prefetch gate, stream per batch, finalize apply

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/file-phase.ts` (replace
  `startPrefetch` whole-repo prefetch; rewrite `onBatch`; add `applyFinalize`).
- Test: `tests/core/domains/ingest/pipeline/enrichment/file-phase.test.ts`
  (rewrite gate-mechanism cases; keep apply-correctness assertions).

The whole-repo `fileMetadata`/`pendingBatches` gate is removed. `onBatch`
computes the batch's file signals via `streamFileBatch` (fallback
`buildFileSignals({paths})`) and applies them immediately.

- [ ] **Step 1: Write the failing test** — onBatch applies streamed file signals
      with no prefetch:

```ts
it("onBatch streams file signals per batch without a whole-repo prefetch", async () => {
  const streamFileBatch = vi
    .fn()
    .mockResolvedValue(new Map([["src/a.ts", { commitCount: 3 }]]));
  const applyFileSignals = vi
    .spyOn(applier, "applyFileSignals")
    .mockResolvedValue();
  filePhase.init(ctxMap({ streamFileBatch }), "coll", "run", "t0");
  filePhase.onBatch("coll", "/repo", [chunkItem("src/a.ts")]);
  await filePhase.drain();
  expect(streamFileBatch).toHaveBeenCalledWith(
    "/repo",
    ["src/a.ts"],
    expect.anything(),
  );
  expect(applyFileSignals).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it, expect FAIL** —
      `npx vitest run tests/core/domains/ingest/pipeline/enrichment/file-phase.test.ts`
      Expected: FAIL — `onBatch` still requires `fileMetadata` (queues, never
      applies without `startPrefetch`).

- [ ] **Step 3: Implement.** Remove `startPrefetch`, `prefetchPromise`,
      `fileMetadata`, `pendingBatches`, `flushPending`, the
      `markPrefetchPending` / `markReady` / `markFailed` calls. Rewrite
      `onBatch`:

```ts
  onBatch(coll: string, absolutePath: string, items: ChunkItem[]): void {
    for (const ctx of this.contexts.values()) {
      const state = this.states.get(ctx.key);
      if (!state) continue;
      const root = ctx.effectiveRoot ?? absolutePath;
      const relPaths = uniqueRelPaths(items, root); // helper: relative(root, filePath)
      const streamFn =
        ctx.provider.streamFileBatch ??
        ((r: string, p: string[], o?: FileSignalOptions) =>
          ctx.provider.buildFileSignals(r, { ...o, paths: p }));
      const work = streamFn(root, relPaths, { collectionName: this.coll || undefined })
        .then(async (overlays) => {
          await this.applier.applyFileSignals(
            coll, ctx.key, overlays, root, items, ctx.provider.fileSignalTransform, this.runStartedAt,
          );
          state.streamingApplies++;
        })
        .catch((err) => this.recordPrefetchFailure(ctx, state, err));
      state.fileWork.push(work);
    }
  }
```

Add `applyFinalize(coll, root, ctx, fileOverlays)` that calls
`applier.applyFileSignals` for the finalize file map against the whole indexed
file set (finalize applies to all chunks of the listed files — reuse the
backfiller's point lookup or apply by relPath). Keep `awaitPrefetch` as a no-op
(or rename to satisfy CompletionRunner — see Task 6) and `drain`/`getMetrics`.

- [ ] **Step 4: Run it, expect PASS.** Rewrite any file-phase tests that
      asserted the prefetch gate; keep assertions about apply correctness. Run
      the file suite + `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/file-phase.ts tests/core/domains/ingest/pipeline/enrichment/file-phase.test.ts
git commit -m "feat(ingest): FilePhase streams file signals per batch (no prefetch gate)

Why: the whole-repo buildFileSignals prefetch was the root serializer; per-batch
streamFileBatch lets file enrichment overlap embedding and removes the
fileMetadata/pendingBatches gate. Trade-off: per-batch provider calls, hidden
under embedding overlap; bounded memory (no whole-repo fileMetadata held)."
```

---

## Task 5: ChunkPhase — remove ready gate, dispatch immediately, finalize apply

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts` (drop
  `ready`/`markPrefetchPending`/`markReady`/`pendingBatches`; add
  `applyFinalizeChunk`).
- Test: `tests/core/domains/ingest/pipeline/enrichment/chunk-phase.test.ts`
  (rewrite gate cases; keep enrichRemaining/skip-streamed assertions).

- [ ] **Step 1: Write the failing test**

```ts
it("onBatch dispatches chunk enrichment immediately (no ready gate)", async () => {
  const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
  chunkPhase.init(ctxMap({ buildChunkSignals }), "coll", "t0");
  chunkPhase.onBatch("coll", "/repo", [chunkItem("src/a.ts")]);
  await chunkPhase.drain();
  expect(buildChunkSignals).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run it, expect FAIL** — currently `onBatch` queues into
      `pendingBatches` unless `markReady` ran;
      `npx vitest run tests/core/domains/ingest/pipeline/enrichment/chunk-phase.test.ts`.

- [ ] **Step 3: Implement.** Delete `ready`, `pendingBatches`,
      `markPrefetchPending`, `markReady` from `ChunkPhaseState`/class. `onBatch`
      always dispatches `runChunkSignals` immediately. Keep `prefetchFailed`
      (set via a retained `markFailed`) and `enrichRemaining` (catch-up +
      `streamingEnrichedFiles` skip) unchanged. Add
      `applyFinalizeChunk(coll, ctx, chunkOverlays)` that runs
      `applier.applyChunkSignals` for the finalize chunk map.

- [ ] **Step 4: Run it, expect PASS.** Run the chunk suite + `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts tests/core/domains/ingest/pipeline/enrichment/chunk-phase.test.ts
git commit -m "feat(ingest): ChunkPhase dispatches streaming chunk enrichment immediately

Why: the ready gate only existed to wait for the whole-repo file prefetch; with
per-batch file streaming it is gone, so git chunk enrichment streams live with
embedding instead of landing as a post-flush burst. enrichRemaining stays as
catch-up. Trade-off: none — removes a serializer."
```

---

## Task 6: Coordinator — `beginRun`, per-batch sequencing, drive finalize

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`
  (`prefetch` `:179-243` → `beginRun`; `onChunksStored` `:251-255`;
  `awaitCompletion` `:269-291`).
- Test: `tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`
  (rewrite gate suites; PRESERVE signal-value + RunState-isolation assertions).

`beginRun` initializes phases + `markStart` (codegraph sink is created lazily by
the first `streamFileBatch`, so no explicit creation here). `onChunksStored`
sequences file-batch stream BEFORE chunk-batch stream for the same batch so git
`buildChunkSignals` sees the batch's blame/lastFileResult.

- [ ] **Step 1: Write the failing test** — per-batch file precedes chunk:

```ts
it("onChunksStored streams file signals before chunk signals for the same batch", async () => {
  const order: string[] = [];
  const provider = makeProvider({
    streamFileBatch: async () => {
      order.push("file");
      return new Map();
    },
    buildChunkSignals: async () => {
      order.push("chunk");
      return new Map();
    },
  });
  const coord = new EnrichmentCoordinator(qdrant, provider);
  coord.beginRun("/repo", "coll");
  coord.onChunksStored("coll", "/repo", [chunkItem("a.ts")]);
  await coord.awaitCompletion("coll");
  expect(order).toEqual(["file", "chunk"]);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `coord.beginRun is not a function`.

- [ ] **Step 3: Implement.** Rename
      `prefetch(absolutePath, collectionName,     ignoreFilter, changedPaths)` →
      `beginRun(...)`; drop the `filePhase.startPrefetch(changedPaths)` call
      (and the `previousDone` deferral that only guarded the whole-repo call —
      keep FIFO run isolation via the fresh `RunState`). `onChunksStored` awaits
      the file stream then dispatches chunk:

```ts
  onChunksStored(collectionName: string, absolutePath: string, items: ChunkItem[]): void {
    if (!this.currentRun) return;
    const run = this.currentRun;
    // Sequence file→chunk per batch: git buildChunkSignals reads the batch's
    // blame/lastFileResult that streamFileBatch populates. Per-batch ordering
    // replaces the removed whole-repo gate; cheap (one batch's files).
    const fileDone = run.filePhase.onBatch(collectionName, absolutePath, items);
    void Promise.resolve(fileDone).then(() =>
      run.chunkPhase.onBatch(collectionName, absolutePath, items),
    );
  }
```

(Make `FilePhase.onBatch` return the batch's `Promise<void>` so the coordinator
can sequence; it still tracks the work in `state.fileWork` for drain.)

Update the pipeline caller of `prefetch` (search: `.prefetch(`) to `beginRun`.

- [ ] **Step 4: Run it, expect PASS.** Rewrite the gate-mechanism coordinator
      suites; keep `RunState isolation` + signal-value suites. Run the
      coordinator suite + `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/coordinator.ts \
  tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts \
  src/core/domains/ingest/pipeline/base.ts
git commit -m "feat(ingest): coordinator beginRun + per-batch file→chunk sequencing

Why: no whole-repo prefetch to kick off; beginRun only inits phases + markStart.
Per-batch file→chunk ordering preserves git chunk blame-ownership correctness
that the removed gate used to guarantee. Trade-off: a cheap per-batch await."
```

---

## Task 7: CompletionRunner — finalize step + marker reconciliation (§5.8)

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/completion-runner.ts`
  (`run` `:40-149`).
- Modify: `src/core/domains/ingest/pipeline/enrichment/marker-store.ts`
  (`markFileFinal` `:97-110` — accept a `degraded` status path).
- Test:
  `tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts` plus
  extend coordinator marker suites.

Insert a finalize pass after streaming drains and before the final markers, then
make `markFileFinal` honour file-level unenriched (degraded), mirroring chunk.

- [ ] **Step 1: Write the failing test** — finalize applies deferred signals and
      file status reconciles to `degraded` when file-level unenriched remain:

```ts
it("runs finalizeSignals and applies deferred file+chunk overlays", async () => {
  const finalizeSignals = vi.fn().mockResolvedValue({
    file: new Map([["a.ts", { fanIn: 2 }]]),
    chunk: new Map([["a.ts", new Map([["c1", { fanIn: 1 }]])]]),
  });
  // ... wire ctx with finalizeSignals, run CompletionRunner.run, assert
  // applier.applyFileSignals + applyChunkSignals called with the finalize maps.
});

it("marks file degraded when file-level unenriched remain after finalize", async () => {
  const reader: UnenrichedReader = async (_c, _k, level) =>
    level === "file" ? 2 : 0;
  // run with reader; assert markFileFinal called with status "degraded".
});
```

- [ ] **Step 2: Run it, expect FAIL** — `run` never calls `finalizeSignals`;
      `markFileFinal` always writes `completed` unless `failed`.

- [ ] **Step 3: Implement.** In `run`, after step 2 (drain fileWork) and step 6
      (drain chunkWork) — i.e. once streaming has drained — add a finalize pass
      BEFORE the markers:

```ts
// 3.5 finalize: deferred whole-repo signals (codegraph graph metrics).
for (const ctx of contexts.values()) {
  if (!ctx.provider.finalizeSignals || filePhase.hasPrefetchFailed(ctx.key))
    continue;
  const root = ctx.effectiveRoot ?? "";
  const { file, chunk } = await ctx.provider.finalizeSignals(root, {
    collectionName: coll || undefined,
  });
  if (file.size > 0) await filePhase.applyFinalize(coll, root, ctx, file);
  if (chunk.size > 0) await chunkPhase.applyFinalizeChunk(coll, ctx, chunk);
}
await filePhase.drain();
await chunkPhase.drain();
```

Then in step 4 (`markFileFinal`), compute status from `fileUnenriched`:

```ts
      const fileStatus = filePhase.hasPrefetchFailed(ctx.key)
        ? "failed"
        : fileUnenriched > 0
          ? "degraded"
          : "completed";
      await markerStore.markFileFinal(coll, ctx.key, { status: fileStatus, ... });
```

Widen `FileFinalInput["status"]` (in `types.ts`) to include `"degraded"` if not
already. The chunk path (step 7) already reconciles via `chunkUnenriched`. The
`markStart`-before-finalize race guard (`awaitCompletion` awaits
`run.markStartPromise`) is unchanged — verify it still wraps `completion.run`.

- [ ] **Step 4: Run it, expect PASS.** Run completion-runner + coordinator
      marker suites + `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/completion-runner.ts \
  src/core/domains/ingest/pipeline/enrichment/marker-store.ts \
  src/core/domains/ingest/pipeline/enrichment/types.ts \
  tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts
git commit -m "feat(ingest): finalize pass + stale-marker reconciliation

Why: deferred codegraph signals are applied in one finalize pass before final
markers, and file status now reconciles to degraded on residual unenriched
(mirrors chunk) so get_index_status is never stuck in_progress. Trade-off: one
extra unenriched re-count per level at finalize."
```

---

## Task 8: Applier — payload file↔chunk isolation invariant + regression (§5.7)

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/applier.ts` (assert/keep
  per-level `key`; no behavior change).
- Test:
  `tests/core/domains/ingest/pipeline/enrichment/payload-isolation.test.ts`
  (create) — uses `MockQdrantManager` modelling nested-key `set_payload`.

- [ ] **Step 1: Write the failing test** — file-then-chunk and chunk-then-file
      on the same point both survive:

```ts
// payload-isolation.test.ts
import { describe, expect, it } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";

describe("payload file↔chunk isolation", () => {
  it("chunk write does not clobber file payload (and vice versa) on the same point", async () => {
    const qdrant = new MockQdrantManager();
    await qdrant.upsertPoints("c", [{ id: "p1", vector: [], payload: {} }]);
    const applier = new EnrichmentApplier(qdrant as never);

    await applier.applyFileSignals(
      "c",
      "git",
      new Map([["a.ts", { commitCount: 5 }]]),
      "/r",
      [chunkItem("a.ts", "p1")],
      undefined,
      "t0",
    );
    await applier.applyChunkSignals(
      "c",
      "git",
      new Map([["a.ts", new Map([["p1", { churnRatio: 1 }]])]]),
      "t0",
    );

    const p = await qdrant.getPoint("c", "p1");
    expect((p!.payload as any).git.file.commitCount).toBe(5); // survived chunk write
    expect((p!.payload as any).git.chunk.churnRatio).toBe(1); // survived file write
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — only if `MockQdrantManager` does NOT
      model nested-key `set_payload` (it likely merges/overwrites at root). Run:
      `npx vitest run tests/core/domains/ingest/pipeline/enrichment/payload-isolation.test.ts`
      Expected FAIL: `git.file.commitCount` undefined after the chunk write
      (root-level overwrite) — proving the test exercises the hazard.

- [ ] **Step 3: Implement.** Make
      `MockQdrantManager.batchSetPayload`/`setPayload` honour `op.key` as a
      nested path (set at `git.file` / `git.chunk` without replacing the
      sibling), matching real Qdrant — in
      `tests/core/domains/ingest/__helpers__/test-helpers.ts`. The applier
      itself already writes the correct per-level `key`
      (`applier.ts:97,105,123,175,216`); add an explicit assertion comment + (if
      missing) a guard that `applyFileSignals`/`applyChunkSignals` NEVER emit an
      op without `key`. No production behavior change is expected — the test
      locks the invariant.

- [ ] **Step 4: Run it, expect PASS.** Run the enrichment suite +
      `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/applier.ts \
  tests/core/domains/ingest/pipeline/enrichment/payload-isolation.test.ts \
  tests/core/domains/ingest/__helpers__/test-helpers.ts
git commit -m "test(ingest): lock file↔chunk payload isolation invariant

Why: codegraph finalize writes both levels to shared chunk points; a regression
test (nested-key set_payload) proves file and chunk payloads never clobber each
other. Applier already uses per-level keys — this pins it against future writers."
```

---

## Task 9: Live testing (§7.1)

**Files:** none (validation only). Produce a short report; file follow-up issues
for any gap.

- [ ] **Step 1: Full local gate.**
      `npx tsc --noEmit && npx eslint . && npx vitest run` — all green.
- [ ] **Step 2: Build + link the worktree.** `npm run build && npm link`;
      reconnect MCP servers in Claude Code.
- [ ] **Step 3: Full reset self-test index.**
      `mcp__tea-rags__force_reindex project=tea-rags`. During the run, tail
      debug logs and confirm `STREAMING_APPLY` /
      `STREAMING_CHUNK_ENRICHMENT_COMPLETE` fire DURING embedding (overlap), not
      only after.
- [ ] **Step 4: Status honesty.**
      `mcp__tea-rags__get_index_status     project=tea-rags` → `git` and
      `codegraph.symbols` both show `file` and `chunk` `completed`, no stale
      `in_progress`.
- [ ] **Step 5: Payload isolation on real data.** `mcp__tea-rags__find_symbol`
      (or `semantic_search`) on a known method; confirm the returned payload
      carries `git.file.*` AND `git.chunk.*` AND `codegraph.symbols.file.*` AND
      `codegraph.symbols.chunk.*` simultaneously.
- [ ] **Step 6: Scale + memory (taxdome).** Monitored `force_reindex` of taxdome
      with the memoryUsage heartbeat harness — verify enrichment overlaps
      embedding (no ~58min post-embedding burst), `heapUsed`/`rss` stay bounded,
      and final `get_index_status` is `completed` for both levels.
- [ ] **Step 7: Report** the six checks (pass/fail + numbers) in the session.

---

## Post-plan: beads sync

Per `.claude/rules/.local/plan-beads-sync.md`, after the plan is approved:

- Create ONE beads epic for this plan
  (`Streaming File Enrichment — unified stream/finalize`).
- One bead task per plan Task (1–9) with `dependsOn` chaining (Task N+1 depends
  on Task N), labels `architecture` / `api` / `ingest` as fits, and a `relates`
  link to the 30GB OOM follow-up epic `tea-rags-mcp-gmuf`.
- Run `bd dolt pull` before creating to avoid DB conflicts.

---

## Self-review (spec coverage)

- §5.1 contract → Task 1. §5.2 git → Task 2; codegraph → Task 3.
- §5.3 keep buildFileSignals → Tasks 2/3 (left intact). §5.4 scheduler → Tasks
  4/5/6. §5.5 streaming schedule → Tasks 4/5/6 collectively.
- §5.6 run-state release → Task 3 (`clearRunState`). §5.7 payload isolation →
  Task 8. §5.8 marker reconciliation → Task 7. §6 trade-offs → encoded in
  per-Task `Why:` lines. §7 testing → each Task RED/GREEN; §7.1 live → Task 9.
- §8 affected files → all covered (provider.ts, both providers, file-phase,
  chunk-phase, coordinator, completion-runner, applier, marker-store, types.ts,
  base.ts pipeline caller).
