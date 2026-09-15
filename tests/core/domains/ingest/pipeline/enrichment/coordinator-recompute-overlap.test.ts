import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnrichmentRunHandle } from "../../../../../../src/core/contracts/types/enrichment-executor.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { reindexRunSpec } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/run-spec.js";
import type { EnrichmentProvider } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";
import { pipelineLog } from "../../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";

/**
 * bd tea-rags-mcp-71n0p / tea-rags-mcp-u3e77 — a recompute must not open its run
 * while the completion of the run before it is still in flight.
 *
 * `--force-enrichments` runs the working-tree sync first and then the recompute
 * on the same coordinator. The sync leg's run completes in the background, so
 * without a wait its tail overlaps the recompute:
 *  - its `releaseRun` drops the worker-side provider state the
 *    recompute's deferred chunk pass reads (wrong chunk signals, 71n0p);
 *  - its terminal chunk marker lands after the recompute's `_run` write, so the
 *    health mapper's runId comparison renders `in_progress` (u3e77).
 */

type OverlapEvent =
  | { kind: "scroll" }
  | { kind: "marker"; key: string; runId?: string }
  | { kind: "release" }
  | { kind: "dispatch"; method: string };

const PROVIDER_KEY = "codegraph.symbols";
const CHUNK_MARKER_KEY = `enrichment.${PROVIDER_KEY}.chunk`;
const RUN_POINTER_KEY = "enrichment._run";

/** Qdrant double that logs the stored-chunk scroll and every enrichment marker write, in order. */
function recordingQdrant(events: OverlapEvent[]): Record<string, unknown> {
  return {
    scrollFiltered: vi.fn(async () => {
      events.push({ kind: "scroll" });
      return [
        { id: "c1", payload: { relativePath: "src/a.ts", startLine: 1, endLine: 10 } },
        { id: "c2", payload: { relativePath: "src/b.ts", startLine: 1, endLine: 10 } },
      ];
    }),
    setPayload: vi.fn().mockResolvedValue(undefined),
    batchSetPayload: vi.fn(async (_coll: string, ops: { key?: string; payload?: { runId?: string } }[]) => {
      for (const op of ops) {
        if (op.key?.startsWith("enrichment.")) events.push({ kind: "marker", key: op.key, runId: op.payload?.runId });
      }
    }),
    countPoints: vi.fn().mockResolvedValue(0),
    getPoint: vi.fn().mockResolvedValue(null),
    upsertPoints: vi.fn().mockResolvedValue(undefined),
  };
}

/** Inline executor that logs provider dispatches and collection releases into the same stream. */
class RecordingEnrichmentExecutor extends InlineEnrichmentExecutor {
  constructor(private readonly events: OverlapEvent[]) {
    super();
  }

  override async runFileBatch(
    ...args: Parameters<InlineEnrichmentExecutor["runFileBatch"]>
  ): ReturnType<InlineEnrichmentExecutor["runFileBatch"]> {
    this.events.push({ kind: "dispatch", method: "runFileBatch" });
    return super.runFileBatch(...args);
  }

  override async runChunkBatch(
    ...args: Parameters<InlineEnrichmentExecutor["runChunkBatch"]>
  ): ReturnType<InlineEnrichmentExecutor["runChunkBatch"]> {
    this.events.push({ kind: "dispatch", method: "runChunkBatch" });
    return super.runChunkBatch(...args);
  }

  override async runFinalize(
    ...args: Parameters<InlineEnrichmentExecutor["runFinalize"]>
  ): ReturnType<InlineEnrichmentExecutor["runFinalize"]> {
    this.events.push({ kind: "dispatch", method: "runFinalize" });
    return super.runFinalize(...args);
  }

  override async releaseRun(providers: EnrichmentProvider[], run: EnrichmentRunHandle): Promise<void> {
    this.events.push({ kind: "release" });
    return super.releaseRun(providers, run);
  }
}

/**
 * Codegraph-shaped provider whose FIRST finalize waits for `held` — that keeps
 * the first run's completion in flight for as long as the test wants. Later
 * finalizes return at once.
 */
function heldProvider(held: Promise<void>, failFirstFinalize = false): EnrichmentProvider {
  let finalizeCalls = 0;
  return {
    key: PROVIDER_KEY,
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    defersChunkEnrichment: true,
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    finalizeSignals: vi.fn(async () => {
      finalizeCalls += 1;
      if (finalizeCalls === 1) {
        await held;
        if (failFirstFinalize) throw new Error("finalize failed");
      }
      return new Map();
    }),
  } as unknown as EnrichmentProvider;
}

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Real-timer pause long enough for an un-gated recompute to run to completion. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/** Resolves to "resolved" or "timed-out" — a regression fails instead of hanging the suite. */
async function withinMs(promise: Promise<unknown>, ms: number): Promise<"resolved" | "timed-out"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => {
      resolve("timed-out");
    }, ms);
  });
  try {
    return await Promise.race([promise.then(() => "resolved" as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function markers(events: OverlapEvent[], key: string): { index: number; runId?: string }[] {
  return events.flatMap((event, index) =>
    event.kind === "marker" && event.key === key ? [{ index, runId: event.runId }] : [],
  );
}

describe("EnrichmentCoordinator.recomputeEnrichments — previous run still completing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for the previous run's completion before scrolling or opening its own run", async () => {
    const phases = vi.spyOn(pipelineLog, "enrichmentPhase");
    const events: OverlapEvent[] = [];
    const held = gate();
    const coordinator = new EnrichmentCoordinator(
      recordingQdrant(events) as never,
      [heldProvider(held.opened)],
      undefined,
      new RecordingEnrichmentExecutor(events),
    );

    // The sync leg: a run whose completion the pipeline leaves in the background.
    const syncRun = coordinator.beginRun(reindexRunSpec({ absolutePath: "/repo", collection: "coll", fileCount: 0 }));
    const syncLeg = coordinator.awaitCompletion(syncRun);
    const recompute = coordinator.recomputeEnrichments("coll", "/repo", ["codegraph"]);
    await settle();

    expect(events.filter((event) => event.kind === "scroll")).toHaveLength(0);
    const runIdA = markers(events, RUN_POINTER_KEY)[0]?.runId;
    expect(runIdA).toBeDefined();
    expect(markers(events, RUN_POINTER_KEY).map((m) => m.runId)).toEqual([runIdA]);

    held.open();
    await recompute;
    await syncLeg;

    const runIdB = markers(events, RUN_POINTER_KEY).at(-1)?.runId;
    expect(runIdB).toBeDefined();
    expect(runIdB).not.toBe(runIdA);

    // Run A holds no chunks, so its only dispatch is its finalize — the first
    // one logged. Every other dispatch belongs to B, whose provider work must
    // not start until A has released the collection.
    const aFinalize = events.findIndex((event) => event.kind === "dispatch" && event.method === "runFinalize");
    const aChunkMarker = markers(events, CHUNK_MARKER_KEY).find((m) => m.runId === runIdA)?.index ?? -1;
    const aRelease = events.findIndex((event) => event.kind === "release");
    const bRunPointer = markers(events, RUN_POINTER_KEY).find((m) => m.runId === runIdB)?.index ?? -1;
    const bFirstDispatch = events.findIndex((event, index) => event.kind === "dispatch" && index !== aFinalize);

    expect(aFinalize).toBeGreaterThanOrEqual(0);
    expect(aChunkMarker).toBeGreaterThanOrEqual(0);
    expect(aRelease).toBeGreaterThanOrEqual(0);
    expect(bRunPointer).toBeGreaterThanOrEqual(0);
    expect(bFirstDispatch).toBeGreaterThanOrEqual(0);
    expect(aChunkMarker).toBeLessThan(bRunPointer);
    expect(aRelease).toBeLessThan(bRunPointer);
    expect(aRelease).toBeLessThan(bFirstDispatch);
    expect(phases).toHaveBeenCalledWith(
      "RECOMPUTE_AWAIT_PREVIOUS_RUN",
      expect.objectContaining({ collection: "coll", durationMs: expect.any(Number) }),
    );
  });

  it("leaves the last chunk marker under the same runId as the last run pointer (u3e77)", async () => {
    const events: OverlapEvent[] = [];
    const held = gate();
    const coordinator = new EnrichmentCoordinator(
      recordingQdrant(events) as never,
      [heldProvider(held.opened)],
      undefined,
      new RecordingEnrichmentExecutor(events),
    );

    const syncRun = coordinator.beginRun(reindexRunSpec({ absolutePath: "/repo", collection: "coll", fileCount: 0 }));
    const syncLeg = coordinator.awaitCompletion(syncRun);
    const recompute = coordinator.recomputeEnrichments("coll", "/repo", ["codegraph"]);
    await settle();
    held.open();
    await recompute;
    await syncLeg;

    const lastChunkMarker = markers(events, CHUNK_MARKER_KEY).at(-1);
    const lastRunPointer = markers(events, RUN_POINTER_KEY).at(-1);
    expect(lastChunkMarker?.runId).toBeDefined();
    expect(lastChunkMarker?.runId).toBe(lastRunPointer?.runId);
  });

  it("does not wait on a run whose completion was never started", async () => {
    // A run opened by beginRun whose pipeline threw before awaitCompletion has
    // nothing running to overlap with; its donePromise never settles.
    const phases = vi.spyOn(pipelineLog, "enrichmentPhase");
    const events: OverlapEvent[] = [];
    const coordinator = new EnrichmentCoordinator(
      recordingQdrant(events) as never,
      [heldProvider(Promise.resolve())],
      undefined,
      new RecordingEnrichmentExecutor(events),
    );

    coordinator.beginRun(reindexRunSpec({ absolutePath: "/repo", collection: "coll", fileCount: 0 }));

    expect(await withinMs(coordinator.recomputeEnrichments("coll", "/repo", ["codegraph"]), 2_000)).toBe("resolved");
    expect(phases).not.toHaveBeenCalledWith("RECOMPUTE_AWAIT_PREVIOUS_RUN", expect.anything());
  });

  it("does not report a wait when the previous run's completion already settled", async () => {
    const phases = vi.spyOn(pipelineLog, "enrichmentPhase");
    const events: OverlapEvent[] = [];
    const coordinator = new EnrichmentCoordinator(
      recordingQdrant(events) as never,
      [heldProvider(Promise.resolve())],
      undefined,
      new RecordingEnrichmentExecutor(events),
    );

    const syncRun = coordinator.beginRun(reindexRunSpec({ absolutePath: "/repo", collection: "coll", fileCount: 0 }));
    await coordinator.awaitCompletion(syncRun);
    await coordinator.recomputeEnrichments("coll", "/repo", ["codegraph"]);

    expect(phases).not.toHaveBeenCalledWith("RECOMPUTE_AWAIT_PREVIOUS_RUN", expect.anything());
  });

  it("still runs after the previous run's completion failed", async () => {
    const events: OverlapEvent[] = [];
    const held = gate();
    const coordinator = new EnrichmentCoordinator(
      recordingQdrant(events) as never,
      [heldProvider(held.opened, true)],
      undefined,
      new RecordingEnrichmentExecutor(events),
    );

    const syncRun = coordinator.beginRun(reindexRunSpec({ absolutePath: "/repo", collection: "coll", fileCount: 0 }));
    const syncLeg = coordinator.awaitCompletion(syncRun).catch((error: unknown) => error);
    const recompute = coordinator.recomputeEnrichments("coll", "/repo", ["codegraph"]);
    await settle();
    held.open();

    expect(await withinMs(recompute, 2_000)).toBe("resolved");
    expect(await syncLeg).toBeInstanceOf(Error);
    expect(events.filter((event) => event.kind === "scroll")).toHaveLength(1);
  });
});
