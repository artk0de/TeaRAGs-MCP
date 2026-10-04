/**
 * IndexingOps#resolveChunkerConfig (bd tea-rags-mcp-xi2r9.3) — the chunker
 * config an index run on a collection would chunk a changed file with, for a
 * reader that must chunk like ingest without indexing: the working-tree chunk
 * layer. Same model-derived size as every sync (`syncChunkingOverrides`), but
 * READ-ONLY — a missing marker `modelInfo` is resolved live and never
 * backfilled into the shared index.
 */

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";

const MODEL_INFO = { model: "nomic-embed-text", contextLength: 2048, dimensions: 768 };
/** 2048 tokens × 2 chars/token × 0.8 safety factor. */
const MODEL_DERIVED_CHUNK_SIZE = 3276;

function makeDeps(markerPayload: Record<string, unknown> | null): IndexingOpsDeps {
  return {
    qdrant: {
      getPoint: vi.fn().mockResolvedValue(markerPayload ? { id: "marker", payload: markerPayload } : null),
      setPayload: vi.fn().mockResolvedValue(undefined),
    } as never,
    embeddings: { resolveModelInfo: vi.fn().mockResolvedValue(MODEL_INFO) } as never,
    config: { chunkSize: 2500, chunkOverlap: 300, userSetChunkSize: false } as never,
    indexing: {} as never,
    reindex: {} as never,
    enrichment: {} as never,
    snapshotDir: "/tmp/snap",
  };
}

describe("IndexingOps#resolveChunkerConfig", () => {
  it("should chunk with the size derived from the model the index marker records", async () => {
    const deps = makeDeps({ indexingComplete: true, modelInfo: MODEL_INFO });

    const config = await new IndexingOps(deps).resolveChunkerConfig("code_x");

    expect(config).toEqual({
      chunkSize: MODEL_DERIVED_CHUNK_SIZE,
      chunkOverlap: 300,
      maxChunkSize: MODEL_DERIVED_CHUNK_SIZE,
    });
    expect(deps.embeddings.resolveModelInfo).not.toHaveBeenCalled();
  });

  it("should resolve the model live without writing it back when the marker lacks it", async () => {
    const deps = makeDeps({ indexingComplete: true });

    const config = await new IndexingOps(deps).resolveChunkerConfig("code_x");

    expect(config.chunkSize).toBe(MODEL_DERIVED_CHUNK_SIZE);
    expect(deps.qdrant.setPayload).not.toHaveBeenCalled();
  });

  it("should keep a smaller size the user pinned", async () => {
    const deps = makeDeps({ indexingComplete: true, modelInfo: MODEL_INFO });
    deps.config = { chunkSize: 1200, chunkOverlap: 100, userSetChunkSize: true } as never;

    const config = await new IndexingOps(deps).resolveChunkerConfig("code_x");

    expect(config).toEqual({ chunkSize: 1200, chunkOverlap: 100, maxChunkSize: 1200 });
  });
});
