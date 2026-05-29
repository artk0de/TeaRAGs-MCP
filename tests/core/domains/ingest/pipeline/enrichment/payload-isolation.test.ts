import { describe, expect, it } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import type { ChunkItem } from "../../../../../../src/core/domains/ingest/pipeline/types.js";

/** Minimal ChunkItem whose filePath sits under pathBase "/r" so the applier's
 *  `relative("/r", filePath)` resolves to the overlay key. */
function chunkItem(relPath: string, chunkId: string): ChunkItem {
  return {
    chunkId,
    chunk: {
      content: "",
      startLine: 1,
      endLine: 5,
      metadata: { filePath: `/r/${relPath}` },
    },
  } as unknown as ChunkItem;
}

describe("payload file↔chunk isolation", () => {
  it("chunk write does not clobber file payload (and vice versa) on the same point", async () => {
    const qdrant = new MockQdrantManager();
    await qdrant.createCollection("c", 384);
    await qdrant.addPoints("c", [{ id: "p1", vector: new Array(384).fill(0.1), payload: {} }]);
    const applier = new EnrichmentApplier(qdrant as never);

    // File write under `git.file`.
    await applier.applyFileSignals(
      "c",
      "git",
      new Map([["a.ts", { commitCount: 5 }]]),
      "/r",
      [chunkItem("a.ts", "p1")],
      undefined,
      "t0",
    );
    // Chunk write under `git.chunk` on the SAME point.
    await applier.applyChunkSignals("c", "git", new Map([["a.ts", new Map([["p1", { churnRatio: 1 }]])]]), "t0");

    const p = (await qdrant.getPoint("c", "p1"))!;
    // file survived the chunk write, chunk survived the file write — nested keys
    // keep `git.file` and `git.chunk` strictly disjoint.
    expect(p.payload.git.file.commitCount).toBe(5);
    expect(p.payload.git.chunk.churnRatio).toBe(1);
  });

  it("file write then chunk write then file write preserves both sub-trees", async () => {
    const qdrant = new MockQdrantManager();
    await qdrant.createCollection("c", 384);
    await qdrant.addPoints("c", [{ id: "p1", vector: new Array(384).fill(0.1), payload: {} }]);
    const applier = new EnrichmentApplier(qdrant as never);

    await applier.applyChunkSignals("c", "git", new Map([["a.ts", new Map([["p1", { churnRatio: 1 }]])]]), "t0");
    await applier.applyFileSignals(
      "c",
      "git",
      new Map([["a.ts", { commitCount: 5 }]]),
      "/r",
      [chunkItem("a.ts", "p1")],
      undefined,
      "t0",
    );

    const p = (await qdrant.getPoint("c", "p1"))!;
    expect(p.payload.git.chunk.churnRatio).toBe(1);
    expect(p.payload.git.file.commitCount).toBe(5);
    expect(p.payload.git.file.enrichedAt).toBe("t0");
  });
});
