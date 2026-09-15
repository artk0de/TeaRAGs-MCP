import { describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { reindexRunSpec } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/run-spec.js";

/**
 * bd tea-rags-mcp-39xca.3 — `beginRun` hands back an `EnrichmentRunHandle`, and
 * every per-run entry takes it. A call can then only reach the run that issued
 * the handle: before, each entry read `currentRun`, so a call meant for a run a
 * newer `beginRun` had replaced silently landed on the newer one.
 */

type RecordedMarkerOp = { key?: string; payload?: { runId?: string } };

function recordingQdrant(ops: RecordedMarkerOp[]) {
  return {
    getPoint: vi.fn().mockResolvedValue(null),
    setPayload: vi.fn().mockResolvedValue(undefined),
    batchSetPayload: vi.fn(async (_collection: string, batch: RecordedMarkerOp[]) => {
      ops.push(...batch);
      return Promise.resolve();
    }),
  } as never;
}

function deferringProvider() {
  return {
    key: "codegraph.symbols",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    defersChunkEnrichment: true,
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    finalizeSignals: vi.fn().mockResolvedValue(new Map()),
  } as never;
}

function recordingExecutor(dispatched: Map<string, unknown[]>[]) {
  return {
    runFileBatch: vi.fn().mockResolvedValue(new Map()),
    runFileSignalsRecovery: vi.fn().mockResolvedValue(new Map()),
    runChunkBatch: vi.fn(async (_provider: unknown, _root: string, chunkMap: Map<string, unknown[]>) => {
      dispatched.push(new Map(chunkMap));
      return Promise.resolve(new Map());
    }),
    runFinalize: vi.fn().mockResolvedValue(new Map()),
    releaseRun: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as never;
}

const spec = () => reindexRunSpec({ absolutePath: "/repo", collection: "coll", fileCount: 0 });

describe("EnrichmentCoordinator — per-run entries take the run's handle (39xca.3)", () => {
  it("hands back the identity of the run it opened", async () => {
    const ops: RecordedMarkerOp[] = [];
    const coordinator = new EnrichmentCoordinator(
      recordingQdrant(ops),
      deferringProvider(),
      undefined,
      recordingExecutor([]),
    );

    const run = coordinator.beginRun(spec());
    await coordinator.awaitCompletion(run);

    expect(run.collection).toBe("coll");
    expect(run.absolutePath).toBe("/repo");
    const runPointer = ops.find((op) => op.key === "enrichment._run");
    expect(runPointer?.payload?.runId).toBe(run.runId);
  });

  it("a superseded run's handle reaches only that run, never the current one", async () => {
    const dispatched: Map<string, unknown[]>[] = [];
    const coordinator = new EnrichmentCoordinator(
      recordingQdrant([]),
      deferringProvider(),
      undefined,
      recordingExecutor(dispatched),
    );
    const entries = [{ chunkId: "c-1", startLine: 1, endLine: 20 }];

    const older = coordinator.beginRun(spec());
    const current = coordinator.beginRun(spec());
    coordinator.seedDeferredChunks(older, new Map([["codegraph.symbols", new Map([["src/app.ts", entries]])]]));

    await coordinator.awaitCompletion(current);
    expect(dispatched).toEqual([]);

    await coordinator.awaitCompletion(older);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.get("src/app.ts")).toEqual(entries);
  });

  it("awaitCompletion closes the run its handle names, writing that run's terminal markers", async () => {
    const ops: RecordedMarkerOp[] = [];
    const coordinator = new EnrichmentCoordinator(
      recordingQdrant(ops),
      deferringProvider(),
      undefined,
      recordingExecutor([]),
    );

    const older = coordinator.beginRun(spec());
    const current = coordinator.beginRun(spec());
    await coordinator.awaitCompletion(older);

    const chunkMarkers = ops.filter((op) => op.key === "enrichment.codegraph.symbols.chunk");
    expect(chunkMarkers.map((op) => op.payload?.runId)).toEqual([older.runId]);
    expect(older.runId).not.toBe(current.runId);
  });

  it("ignores a handle it did not issue", () => {
    const provider = deferringProvider() as unknown as { buildFileSignals: ReturnType<typeof vi.fn> };
    const issuer = new EnrichmentCoordinator(
      recordingQdrant([]),
      deferringProvider(),
      undefined,
      recordingExecutor([]),
    );
    const coordinator = new EnrichmentCoordinator(
      recordingQdrant([]),
      provider as never,
      undefined,
      recordingExecutor([]),
    );
    coordinator.beginRun(spec());

    const foreign = issuer.beginRun(spec());
    coordinator.onChunksStored(foreign, [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 5 } } as never,
    ]);

    expect(provider.buildFileSignals).not.toHaveBeenCalled();
  });
});
