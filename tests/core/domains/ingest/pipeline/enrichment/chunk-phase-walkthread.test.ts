/**
 * bd tea-rags-mcp-iqpuu — ChunkPhase owns the churn-walk thread lifecycle.
 *
 * A provider declaring `createChunkChurnWalkThread` gets ONE run-scoped walk
 * thread: lazily created at the first chunk dispatch, attached to every
 * chunk-signal options object, closed at drain(). Providers without the hook
 * never see a thread. The per-walk `onWalkStats` callback is bound to the
 * pipeline debug log ([ChunkChurn] WALK line + chunkChurn stage time).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { pipelineLog } from "../../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    key: "git",
    provider: { key: "git", buildChunkSignals: vi.fn().mockResolvedValue(new Map()), ...overrides } as any,
    effectiveRoot: "/repo",
    ignoreFilter: null as any,
  };
}

const batchOf = (rel: string, chunkId: string) =>
  [{ chunkId, chunk: { metadata: { filePath: `/repo/${rel}` }, startLine: 1, endLine: 10 } }] as any[];

describe("ChunkPhase churn-walk thread lifecycle (bd tea-rags-mcp-iqpuu)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lazily creates the provider-declared walk thread once and attaches it to chunk-signal options", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const fakeThread = { walk: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const createChunkChurnWalkThread = vi.fn(() => fakeThread);
    const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
    const ctx = buildCtx({ buildChunkSignals, createChunkChurnWalkThread });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

    phase.onBatch("coll", "/repo", batchOf("src/a.ts", "c1"));
    phase.onBatch("coll", "/repo", batchOf("src/b.ts", "c2"));
    await phase.drain();

    expect(createChunkChurnWalkThread).toHaveBeenCalledTimes(1);
    expect(buildChunkSignals).toHaveBeenCalledTimes(2);
    for (const call of buildChunkSignals.mock.calls) {
      expect(call[2].churnWalkThread).toBe(fakeThread);
    }
  });

  it("closes the walk thread at drain", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const fakeThread = { walk: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const ctx = buildCtx({ createChunkChurnWalkThread: vi.fn(() => fakeThread) });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

    phase.onBatch("coll", "/repo", batchOf("src/a.ts", "c1"));
    expect(fakeThread.close).not.toHaveBeenCalled();
    await phase.drain();

    expect(fakeThread.close).toHaveBeenCalledTimes(1);
  });

  it("does not attach a walk thread for providers without the hook", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
    const ctx = buildCtx({ buildChunkSignals });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

    phase.onBatch("coll", "/repo", batchOf("src/a.ts", "c1"));
    await phase.drain();

    expect(buildChunkSignals).toHaveBeenCalledTimes(1);
    expect(buildChunkSignals.mock.calls[0][2].churnWalkThread).toBeUndefined();
  });

  it("binds onWalkStats to the [ChunkChurn] pipeline log", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const stepSpy = vi.spyOn(pipelineLog, "step");
    const stageSpy = vi.spyOn(pipelineLog, "addStageTime");

    const buildChunkSignals = vi.fn().mockImplementation(async (_root: string, _map: unknown, options: any) => {
      options?.onWalkStats?.({
        files: 1,
        commits: 2,
        holdCount: 2,
        semWaitMs: 0,
        blobReads: 4,
        patches: 2,
        memoHits: 0,
        wallMs: 12,
      });
      return new Map();
    });
    const ctx = buildCtx({ buildChunkSignals });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

    phase.onBatch("coll", "/repo", batchOf("src/a.ts", "c1"));
    await phase.drain();

    expect(stepSpy).toHaveBeenCalledWith(
      { component: "ChunkChurn" },
      "WALK",
      expect.objectContaining({ provider: "git", blobReads: 4, wallMs: 12 }),
    );
    expect(stageSpy).toHaveBeenCalledWith("chunkChurn", 12);
  });
});
