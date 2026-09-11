import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/contracts/constants.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import type { CodegraphPayloadHealRunner } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/codegraph-payload-heal.js";
import { CompletionRunner } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/completion-runner.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { FilePhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/file-phase.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";

async function seedMarkerPoint(qdrant: MockQdrantManager, coll: string): Promise<void> {
  await qdrant.createCollection(coll, 384);
  await qdrant.addPoints(coll, [{ id: INDEXING_METADATA_ID, vector: new Array(384).fill(0), payload: {} }]);
}

function chunkItem(root: string, relPath: string, chunkId: string): unknown {
  return {
    type: "upsert",
    chunkId,
    chunk: { content: "", startLine: 1, endLine: 10, metadata: { filePath: `${root}/${relPath}` } },
  };
}

interface Harness {
  runner: CompletionRunner;
  contexts: Map<string, unknown>;
  heal: ReturnType<typeof vi.fn>;
}

async function buildHarness(options: { defers: boolean; heal?: CodegraphPayloadHealRunner["run"] }): Promise<Harness> {
  const qdrant = new MockQdrantManager();
  await seedMarkerPoint(qdrant, "coll");

  const applier = new EnrichmentApplier(qdrant as never);
  const marker = new EnrichmentMarkerStore(qdrant as never);
  const filePhase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
  const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
  filePhase.bindChunkPhase(chunkPhase);
  const backfiller = new EnrichmentBackfiller(applier, qdrant as never, new InlineEnrichmentExecutor());

  const heal = vi.fn(options.heal ?? (async () => ({ pointsRewritten: 4, filesTouched: 2 })));
  const runner = new CompletionRunner({
    filePhase,
    chunkPhase,
    backfiller,
    applier,
    markerStore: marker,
    executor: new InlineEnrichmentExecutor(),
    codegraphHeal: { run: heal } as CodegraphPayloadHealRunner,
  });

  const ctx = {
    key: "codegraph.symbols",
    provider: {
      key: "codegraph.symbols",
      defersChunkEnrichment: options.defers,
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
      resolveRoot: (p: string) => p,
      fileSignalTransform: undefined,
    },
    effectiveRoot: "/repo",
    ignoreFilter: null,
  };
  const contexts = new Map([[ctx.key, ctx]]);
  filePhase.init(contexts as never, "coll", "run-1", "ts");
  chunkPhase.init(contexts as never, "coll", "ts");
  await marker.markRunStart("coll", [ctx.key], "run-1", "ts");

  // Accumulate the run's own chunk map — these are the files the finalize pass
  // rewrites, and exactly the ones the heal must NOT touch again.
  chunkPhase.onBatchProvider("codegraph.symbols", "coll", "/repo", [
    chunkItem("/repo", "src/changed.ts", "c1"),
  ] as never);

  return { runner, contexts: contexts as Map<string, unknown>, heal };
}

// bd tea-rags-mcp-a2ddb — the heal runs inside the completion tail, after the
// deferred chunk pass (which is what rewrites this run's own chunk map) and
// before the terminal chunk marker (whose `wait: true` write is the barrier
// that drains the heal's `wait: false` payload writes).
describe("CompletionRunner codegraph payload heal", () => {
  it("heals with the run's own chunk-map files as the skip set", async () => {
    const { runner, contexts, heal } = await buildHarness({ defers: true });

    await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "2026-09-11T00:00:00.000Z", "run-1");

    expect(heal).toHaveBeenCalledTimes(1);
    const [coll, skip, enrichedAt] = heal.mock.calls[0];
    expect(coll).toBe("coll");
    // The deferred pass CLEARS the chunk map, so a skip set read after it would
    // be empty and the heal would rewrite the run's own files a second time.
    expect([...(skip as Set<string>)]).toEqual(["src/changed.ts"]);
    expect(enrichedAt).toBe("2026-09-11T00:00:00.000Z");
  });

  it("skips the heal entirely when no provider in the run defers chunk enrichment", async () => {
    const { runner, contexts, heal } = await buildHarness({ defers: false });
    await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "ts", "run-1");
    expect(heal).not.toHaveBeenCalled();
  });

  it("does not fail the run when the heal throws — the diff stands for the next run", async () => {
    const { runner, contexts, heal } = await buildHarness({
      defers: true,
      heal: async () => {
        throw new Error("qdrant unreachable");
      },
    });

    const metrics = await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "ts", "run-1");
    expect(heal).toHaveBeenCalledTimes(1);
    expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});
