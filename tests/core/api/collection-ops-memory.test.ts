import { describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../../src/core/adapters/embeddings/base.js";
import type { QdrantCollectionMemoryUsage, QdrantManager } from "../../../src/core/adapters/qdrant/client.js";
import { CollectionOps } from "../../../src/core/api/internal/ops/collection-ops.js";

// CollectionOps#getMemory turns the adapter's raw memory report into the
// consumer-facing CollectionMemoryMetrics frame: file sizes named for what they
// are (apparent, not allocated), payload indexes and "other" folded into one row
// each, and the payload indexes kept per field, largest first, for the DEBUG
// breakdown.

function cell(disk: number, ram: number, cached = 0, expected = 0) {
  return { diskBytes: disk, ramBytes: ram, cachedBytes: cached, expectedCacheBytes: expected };
}

function bytes(apparent: number, ram: number, cached = 0, expected = 0) {
  return { apparentDiskBytes: apparent, ramBytes: ram, cachedBytes: cached, expectedCacheBytes: expected };
}

const report: QdrantCollectionMemoryUsage = {
  total: cell(2_000, 300, 50, 400),
  vectors: [{ name: "dense", storage: cell(400, 0, 20, 400), index: cell(10, 0), quantized: cell(100, 30) }],
  sparseVectors: [{ name: "text", storage: cell(150, 0), index: cell(5, 40) }],
  payload: cell(170, 0),
  payloadIndexes: [
    { name: "git.file.commitCount", usage: cell(300, 20, 5, 0) },
    { name: "symbolId", usage: cell(700, 30, 10, 0) },
    { name: "language", usage: cell(100, 10, 1, 0) },
  ],
  other: [
    { name: "id_tracker", usage: cell(8, 15) },
    { name: "mutable_id_tracker", usage: cell(2, 5) },
  ],
};

function opsWith(getCollectionMemoryUsage: ReturnType<typeof vi.fn>): CollectionOps {
  const qdrant = { getCollectionMemoryUsage } as unknown as QdrantManager;
  return new CollectionOps(qdrant, {} as EmbeddingProvider, false, false);
}

describe("CollectionOps#getMemory", () => {
  it("reads the report for the named collection", async () => {
    const read = vi.fn().mockResolvedValue(report);

    await opsWith(read).getMemory("code_abc");

    expect(read).toHaveBeenCalledWith("code_abc");
  });

  it("frames the report: apparent file size named as such, payload indexes and other folded, fields largest first", async () => {
    const memory = await opsWith(vi.fn().mockResolvedValue(report)).getMemory("code_abc");

    expect(memory).toEqual({
      collection: "code_abc",
      total: bytes(2_000, 300, 50, 400),
      vectors: [{ name: "dense", storage: bytes(400, 0, 20, 400), index: bytes(10, 0), quantized: bytes(100, 30) }],
      sparseVectors: [{ name: "text", storage: bytes(150, 0), index: bytes(5, 40) }],
      payload: bytes(170, 0),
      payloadIndexes: {
        count: 3,
        total: bytes(1_100, 60, 16, 0),
        byField: [
          { field: "symbolId", bytes: bytes(700, 30, 10, 0) },
          { field: "git.file.commitCount", bytes: bytes(300, 20, 5, 0) },
          { field: "language", bytes: bytes(100, 10, 1, 0) },
        ],
      },
      other: bytes(10, 20),
    });
  });

  it("returns null when the server has no memory report for the collection", async () => {
    const memory = await opsWith(vi.fn().mockResolvedValue(undefined)).getMemory("code_abc");

    expect(memory).toBeNull();
  });
});
