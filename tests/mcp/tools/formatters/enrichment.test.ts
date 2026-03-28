// src/tools/formatters/enrichment.test.ts
import { describe, expect, it, vi } from "vitest";

import type { EnrichmentMetrics } from "../../../../src/core/types.js";
import { formatEnrichmentStatus } from "../../../../src/mcp/tools/formatters/enrichment.js";

describe("formatEnrichmentStatus", () => {
  it("should return empty string for skipped enrichment", async () => {
    const result = await formatEnrichmentStatus("skipped", undefined, undefined, "");
    expect(result).toBe("");
  });

  it("should return empty string for undefined enrichment", async () => {
    const result = await formatEnrichmentStatus(undefined, undefined, undefined, "");
    expect(result).toBe("");
  });

  it("should format completed enrichment with duration", async () => {
    const result = await formatEnrichmentStatus("completed", 5000, undefined, "");
    expect(result).toContain("Git enrichment: completed");
    expect(result).toContain("5.0s");
  });

  it("should format other non-background status", async () => {
    const result = await formatEnrichmentStatus("partial", 3000, undefined, "");
    expect(result).toContain("Git enrichment: partial");
    expect(result).toContain("3.0s");
  });

  it("should format background enrichment with per-provider health from getIndexStatus", async () => {
    const mockGetStatus = vi.fn().mockResolvedValue({
      enrichment: {
        git: {
          file: { status: "in_progress", message: "Enrichment in progress..." },
          chunk: { status: "healthy" },
        },
      },
    });

    const result = await formatEnrichmentStatus("background", undefined, mockGetStatus, "/my/path");
    expect(mockGetStatus).toHaveBeenCalledWith("/my/path");
    expect(result).toContain("git.file: in_progress");
  });

  it("should show completed enrichment as healthy", async () => {
    const mockGetStatus = vi.fn().mockResolvedValue({
      enrichment: {
        git: {
          file: { status: "healthy" },
          chunk: { status: "healthy" },
        },
      },
    });

    const result = await formatEnrichmentStatus("background", undefined, mockGetStatus, "/my/path");
    expect(result).toContain("healthy");
  });

  it("should show degraded chunk status with message", async () => {
    const mockGetStatus = vi.fn().mockResolvedValue({
      enrichment: {
        git: {
          file: { status: "healthy" },
          chunk: {
            status: "degraded",
            unenrichedChunks: 23,
            message: "23 chunks missing chunk-level signals.",
          },
        },
      },
    });

    const result = await formatEnrichmentStatus("background", undefined, mockGetStatus, "/my/path");
    expect(result).toContain("degraded");
    expect(result).toContain("23 chunks missing");
  });

  it("should handle getIndexStatus failure gracefully for background", async () => {
    const mockGetStatus = vi.fn().mockRejectedValue(new Error("fail"));

    const result = await formatEnrichmentStatus("background", undefined, mockGetStatus, "/my/path");
    expect(result).toContain("background");
    expect(result).toContain("get_index_status");
  });

  it("should handle no getIndexStatus function for background", async () => {
    const result = await formatEnrichmentStatus("background", undefined, undefined, "/my/path");
    expect(result).toContain("background");
    expect(result).toContain("get_index_status");
  });

  it("should handle getIndexStatus returning no enrichment field", async () => {
    const mockGetStatus = vi.fn().mockResolvedValue({});

    const result = await formatEnrichmentStatus("background", undefined, mockGetStatus, "/my/path");
    expect(result).toContain("background");
    expect(result).toContain("get_index_status");
  });

  describe("enrichment metrics breakdown", () => {
    const metrics: EnrichmentMetrics = {
      prefetchDurationMs: 3100,
      overlapMs: 2000,
      overlapRatio: 0.65,
      streamingApplies: 5,
      flushApplies: 2,
      chunkChurnDurationMs: 2100,
      totalDurationMs: 5200,
      matchedFiles: 1234,
      missedFiles: 56,
      missedPathSamples: [],
      gitLogFileCount: 1500,
      estimatedSavedMs: 1500,
    };

    it("should show file and chunk signal breakdown when metrics provided", async () => {
      const result = await formatEnrichmentStatus("completed", 5200, undefined, "", metrics);
      expect(result).toContain("trajectory.git.file:");
      expect(result).toContain("1234");
      expect(result).toContain("3.1s");
      expect(result).toContain("trajectory.git.chunk:");
      expect(result).toContain("2.1s");
    });

    it("should omit chunk signals line when chunkChurnDurationMs is 0", async () => {
      const noChunkMetrics = { ...metrics, chunkChurnDurationMs: 0 };
      const result = await formatEnrichmentStatus("completed", 5200, undefined, "", noChunkMetrics);
      expect(result).toContain("trajectory.git.file:");
      expect(result).not.toContain("Chunk signals:");
    });

    it("should show metrics for background status too", async () => {
      const mockGetStatus = vi.fn().mockResolvedValue({
        enrichment: {
          git: {
            file: { status: "in_progress" },
            chunk: { status: "pending" },
          },
        },
      });
      const result = await formatEnrichmentStatus("background", undefined, mockGetStatus, "/path", metrics);
      expect(result).toContain("trajectory.git.file:");
    });
  });
});
