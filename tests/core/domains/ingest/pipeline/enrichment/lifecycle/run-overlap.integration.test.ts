/**
 * Two enrichment runs overlapping on one collection, through REAL collaborators
 * (bd tea-rags-mcp-39xca.7): the coordinator, the worker-pool executor with the
 * compiled worker, the codegraph provider rebuilt in that worker, and a codegraph
 * daemon over a per-test DuckDB file. See the harness header for what is real.
 *
 * `coordinator-recompute-overlap.test.ts` and the executor's release unit test pin
 * the ORDER of calls with a held fake provider and a stubbed dispatch. What they
 * cannot show is the consequence in the stored payload: which run's markers the
 * collection ends on, and whether the recompute's deferred pass still reads the
 * walker ranges that live only in the worker's cached provider.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reindexRunSpec } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/run-spec.js";
import {
  ANCHOR_SYMBOL,
  chunkSignalWritesOf,
  eventLoopTurn,
  markerEvents,
  NESTED_OWNER_SYMBOL,
  NESTED_PART_CHUNK_ID,
  NESTED_PART_START_LINE,
  RUN_POINTER_KEY,
  startEnrichmentLifecycleHarness,
  type EnrichmentLifecycleHarness,
} from "./__helpers__/enrichment-lifecycle-harness.js";

describe("enrichment runs overlapping on one collection — real worker pool, codegraph and daemon", () => {
  let harness: EnrichmentLifecycleHarness;

  beforeEach(async () => {
    harness = await startEnrichmentLifecycleHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  /** The fixture only discriminates owners if the graph gives the two symbols different signals. */
  async function expectDistinctOwnerSignals(): Promise<void> {
    const symbols = new Map((await harness.persistedSymbols()).map((symbol) => [symbol.symbolId, symbol]));
    const nested = symbols.get(NESTED_OWNER_SYMBOL);
    expect(nested?.startLine).toBeLessThanOrEqual(NESTED_PART_START_LINE);
    expect(nested?.endLine).toBeGreaterThanOrEqual(NESTED_PART_START_LINE);
    expect(symbols.has(ANCHOR_SYMBOL)).toBe(true);
    expect(await harness.chunkSignalsOf(NESTED_OWNER_SYMBOL)).not.toEqual(await harness.chunkSignalsOf(ANCHOR_SYMBOL));
  }

  it("a recompute opened while the sync leg's run is still completing ends the collection on its own markers and owner overlays (71n0p, u3e77)", async () => {
    const { coordinator, executor, qdrant } = harness;

    // The `--force-enrichments` sync leg: a run over the changed files whose
    // completion the pipeline leaves in the background.
    const syncRun = coordinator.beginRun(reindexRunSpec(harness.runSpecInput()));
    coordinator.onChunksStored(syncRun, harness.chunkItems());
    coordinator.startChunkEnrichment(syncRun, harness.chunkMap());
    const syncFinalize = executor.holdNextFinalize();
    const syncLeg = coordinator.awaitCompletion(syncRun);
    await syncFinalize.reached;

    const recompute = coordinator.recomputeEnrichments(harness.collection, harness.repoRoot, ["codegraph"]);
    // A recompute that does not wait reads the chunk set and writes its `_run`
    // pointer within this turn — the in-memory Qdrant settles in microtasks — so
    // the sync leg's tail is released only once that has had its chance to happen.
    await eventLoopTurn();
    syncFinalize.release();
    await Promise.all([recompute, syncLeg]);

    // `_run` is rewritten by each run's start and by its heartbeats; the runs are
    // told apart by runId, in the order they first wrote the pointer.
    const pointers = markerEvents(qdrant.events, RUN_POINTER_KEY);
    const runIds = [...new Set(pointers.map((pointer) => pointer.runId))];
    expect(runIds).toHaveLength(2);
    expect(runIds[0]).toBe(syncRun.runId);
    const recomputeRunId = runIds[1];
    const recomputePointer = pointers.find((pointer) => pointer.runId === recomputeRunId);

    // Nothing the sync leg writes may land after the recompute's run pointer:
    // its terminal markers would sit under a pointer naming another run.
    const syncLegWritesAfterRecomputeStarted = qdrant.events.filter(
      (event, index) =>
        index > (recomputePointer?.index ?? -1) &&
        ((event.kind === "marker" && event.runId === syncRun.runId) ||
          (event.kind === "release" && event.runId === syncRun.runId)),
    );
    expect(syncLegWritesAfterRecomputeStarted).toEqual([]);

    const marker = await harness.readEnrichmentMarker();
    expect(marker._run.runId).toBe(recomputeRunId);
    expect(marker.codegraph.symbols.file.runId).toBe(recomputeRunId);
    expect(marker.codegraph.symbols.chunk.runId).toBe(recomputeRunId);

    // The recompute's own deferred pass mapped the `#part2` chunk to the nested
    // closure — which it can only do from the walker's ranges.
    await expectDistinctOwnerSignals();
    const recomputeWrites = chunkSignalWritesOf(qdrant.chunkSignalWrites, NESTED_PART_CHUNK_ID, marker._run.startedAt);
    expect(recomputeWrites).toHaveLength(1);
    expect(recomputeWrites[0]).toMatchObject(await harness.chunkSignalsOf(NESTED_OWNER_SYMBOL));
  });

  it("releasing a superseded run leaves the newer run's worker-side state, so its deferred pass still maps owners (39xca.3)", async () => {
    const { coordinator, executor, qdrant } = harness;

    const olderRun = coordinator.beginRun(reindexRunSpec(harness.runSpecInput()));
    coordinator.onChunksStored(olderRun, harness.chunkItems());
    coordinator.startChunkEnrichment(olderRun, harness.chunkMap());
    const olderRelease = executor.holdRelease(olderRun);
    const olderCompletion = coordinator.awaitCompletion(olderRun);
    // Everything of the older run has run except its release.
    await olderRelease.reached;

    const newerRun = coordinator.beginRun(reindexRunSpec(harness.runSpecInput()));
    coordinator.onChunksStored(newerRun, harness.chunkItems());
    coordinator.startChunkEnrichment(newerRun, harness.chunkMap());
    // The newer run's walk has populated the worker's cached provider.
    await executor.fileBatchesSettled();

    olderRelease.release();
    await olderCompletion;
    await coordinator.awaitCompletion(newerRun);

    const marker = await harness.readEnrichmentMarker();
    expect(marker._run.runId).toBe(newerRun.runId);
    expect(marker.codegraph.symbols.chunk.runId).toBe(newerRun.runId);

    await expectDistinctOwnerSignals();
    const newerWrites = chunkSignalWritesOf(qdrant.chunkSignalWrites, NESTED_PART_CHUNK_ID, marker._run.startedAt);
    expect(newerWrites).toHaveLength(1);
    // Not a bare `enrichedAt` stamp: the overlay of the symbol that owns the chunk.
    expect(Object.keys(newerWrites[0] ?? {}).sort()).toEqual(["enrichedAt", "fanIn", "fanOut", "pageRank"]);
    expect(newerWrites[0]).toMatchObject(await harness.chunkSignalsOf(NESTED_OWNER_SYMBOL));
  });
});
