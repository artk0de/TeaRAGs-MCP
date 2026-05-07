import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/domains/ingest/constants.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { FilePhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/file-phase.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";

// Real Qdrant set_payload requires the point to exist; mirror production seed
// (storeIndexingMarker) so EnrichmentMarkerStore writes are visible to read().
async function seedMarkerPoint(qdrant: MockQdrantManager, coll: string): Promise<void> {
  await qdrant.createCollection(coll, 384);
  await qdrant.addPoints(coll, [{ id: INDEXING_METADATA_ID, vector: new Array(384).fill(0), payload: {} }]);
}

function buildCtx(buildFileSignals = vi.fn().mockResolvedValue(new Map())) {
  return {
    key: "git",
    provider: {
      key: "git",
      buildFileSignals,
      buildChunkSignals: vi.fn(),
      resolveRoot: (p: string) => p,
      fileSignalTransform: undefined,
    } as any,
    effectiveRoot: "/repo",
    ignoreFilter: null,
  };
}

const items = [
  {
    chunkId: "c1",
    chunk: {
      metadata: { filePath: "/repo/src/a.ts" },
      startLine: 1,
      endLine: 10,
    },
  } as any,
];

describe("FilePhase", () => {
  it("buffers batches that arrive before prefetch resolves, then drains them", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);

    let resolvePrefetch!: (v: Map<string, any>) => void;
    const buildFileSignals = vi.fn(
      async () =>
        new Promise<Map<string, any>>((res) => {
          resolvePrefetch = res;
        }),
    );
    const ctx = buildCtx(buildFileSignals);

    const phase = new FilePhase(applier, marker);
    phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1", "ts");
    phase.startPrefetch();
    phase.onBatch("coll", "/repo", items); // arrives before prefetch
    expect(applier.matchedFiles).toBe(0);

    resolvePrefetch(new Map([["src/a.ts", { authorPct: 100 }]]));
    await phase.awaitPrefetch();
    await phase.drain();
    expect(applier.matchedFiles).toBeGreaterThanOrEqual(1);
  });

  it("writes markPrefetchFailed when prefetch rejects", async () => {
    const qdrant = new MockQdrantManager();
    await seedMarkerPoint(qdrant, "coll");
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    await marker.markStart("coll", ["git"], "run-1", "ts");

    const ctx = buildCtx(vi.fn().mockRejectedValue(new Error("boom")));
    const phase = new FilePhase(applier, marker);
    phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1", "ts");
    phase.startPrefetch();
    await phase.awaitPrefetch();
    expect(phase.hasPrefetchFailed("git")).toBe(true);
    const m = (await marker.read("coll"))!.git as any;
    expect(m.file.status).toBe("failed");
  });
});
