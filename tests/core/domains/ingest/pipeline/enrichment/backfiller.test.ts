import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
import type { ChunkItem } from "../../../../../../src/core/domains/ingest/pipeline/types.js";

const makeChunkItem = (chunkId: string, filePath: string, startLine: number, endLine: number): ChunkItem => ({
  type: "upsert",
  id: chunkId,
  chunkId,
  codebasePath: "/repo",
  chunk: {
    content: "",
    startLine,
    endLine,
    metadata: { filePath, language: "typescript", chunkIndex: 0 },
  },
});

describe("EnrichmentBackfiller", () => {
  it("fetches file overlays for missed paths and applies them to chunks", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);

    // Drive the seed through the production path: applyFileSignals with an
    // empty fileMetadata map registers "src/a.ts" as missed and pushes
    // {chunkId,startLine,endLine} into _missedFileChunks — same as a real
    // enrichment run where the provider returned no data for this path.
    await applier.applyFileSignals("coll", "git", new Map(), "/repo", [makeChunkItem("c1", "/repo/src/a.ts", 1, 10)]);
    expect(applier.missedFiles).toBe(1);
    expect(applier.matchedFiles).toBe(0);

    const backfiller = new EnrichmentBackfiller(applier, qdrant as any);

    const buildFileSignals = vi.fn().mockResolvedValue(new Map([["src/a.ts", { authorPct: 100 }]]));
    const buildChunkSignals = vi.fn().mockResolvedValue(new Map([["src/a.ts", new Map([["c1", { commits: 3 }]])]]));
    const ctx = {
      key: "git",
      provider: {
        key: "git",
        buildFileSignals,
        buildChunkSignals,
        fileSignalTransform: undefined,
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };

    await backfiller.runFor("coll", ctx, "2026-05-07T10:00:00Z");

    expect(buildFileSignals).toHaveBeenCalledWith("/repo", {
      paths: ["src/a.ts"],
      // Backfiller threads the active collection name through so
      // collection-scoped providers (codegraph) hit the right
      // per-collection store.
      collectionName: "coll",
    });
    expect(applier.matchedFiles).toBe(1);
    expect(applier.missedFiles).toBe(0);
    expect(buildChunkSignals).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no files are missed", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any);
    const buildFileSignals = vi.fn();
    const ctx = {
      key: "git",
      provider: {
        key: "git",
        buildFileSignals,
        buildChunkSignals: vi.fn(),
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };
    await backfiller.runFor("coll", ctx, "ts");
    expect(buildFileSignals).not.toHaveBeenCalled();
  });
});
