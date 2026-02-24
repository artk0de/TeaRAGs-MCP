import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../src/core/ingest/pipeline/enrichment/coordinator.js";
import type { EnrichmentProvider } from "../../../src/core/ingest/pipeline/enrichment/types.js";

describe("EnrichmentCoordinator", () => {
  let mockQdrant: any;
  let mockProvider: EnrichmentProvider;
  let coordinator: EnrichmentCoordinator;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };
    mockProvider = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileMetadata: vi.fn().mockResolvedValue(new Map()),
      buildChunkMetadata: vi.fn().mockResolvedValue(new Map()),
    };
    coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
  });

  it("has provider key accessible", () => {
    expect(coordinator.providerKey).toBe("git");
  });

  it("calls provider.resolveRoot and buildFileMetadata on prefetch", () => {
    coordinator.prefetch("/repo", "test-col");
    expect(mockProvider.resolveRoot).toHaveBeenCalledWith("/repo");
    expect(mockProvider.buildFileMetadata).toHaveBeenCalledWith("/repo");
  });

  it("delegates .git check to provider (coordinator is generic)", () => {
    // Provider returns empty map for non-git paths
    (mockProvider.buildFileMetadata as any).mockResolvedValue(new Map());
    coordinator.prefetch("/some-path", "test-col");
    expect(mockProvider.resolveRoot).toHaveBeenCalled();
    expect(mockProvider.buildFileMetadata).toHaveBeenCalled();
  });

  it("queues batches when prefetch is pending, flushes when ready", async () => {
    // Make buildFileMetadata slow
    let resolvePrefetch: (v: Map<string, Record<string, unknown>>) => void;
    (mockProvider.buildFileMetadata as any).mockReturnValue(
      new Promise((resolve) => {
        resolvePrefetch = resolve;
      }),
    );

    coordinator.prefetch("/repo", "test-col");

    // Queue a batch while prefetch is pending
    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
    ]);

    // No Qdrant calls yet (batch is queued)
    expect(mockQdrant.batchSetPayload).not.toHaveBeenCalled();

    // Resolve prefetch
    resolvePrefetch!(new Map([["src/a.ts", { someData: true }]]));

    // Wait for flush
    await new Promise((r) => setTimeout(r, 10));

    // Now batchSetPayload should have been called (flush applied the queued batch)
    expect(mockQdrant.batchSetPayload).toHaveBeenCalled();
  });

  it("applies immediately when prefetch is already done", async () => {
    // Fast prefetch
    (mockProvider.buildFileMetadata as any).mockResolvedValue(new Map([["src/a.ts", { x: 1 }]]));

    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
    ]);

    await new Promise((r) => setTimeout(r, 10));
    expect(mockQdrant.batchSetPayload).toHaveBeenCalled();
  });

  it("startChunkEnrichment calls provider.buildChunkMetadata", () => {
    coordinator.prefetch("/repo", "test-col");
    const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
    coordinator.startChunkEnrichment("test-col", "/repo", chunkMap);
    expect(mockProvider.buildChunkMetadata).toHaveBeenCalledWith("/repo", chunkMap);
  });

  it("awaitCompletion returns metrics", async () => {
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    const metrics = await coordinator.awaitCompletion("test-col");
    expect(metrics).toHaveProperty("prefetchDurationMs");
    expect(metrics).toHaveProperty("totalDurationMs");
    expect(metrics).toHaveProperty("matchedFiles");
    expect(metrics).toHaveProperty("missedFiles");
  });
});
