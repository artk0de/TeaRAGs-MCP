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

  it("should format background enrichment with progress from getIndexStatus", async () => {
    const mockGetStatus = vi.fn().mockResolvedValue({
      enrichment: {
        status: "in_progress",
        percentage: 42,
        matchedFiles: 80,
        missedFiles: 20,
        gitLogFileCount: 150,
      },
    });

    const result = await formatEnrichmentStatus("background", undefined, mockGetStatus, "/my/path");
    expect(mockGetStatus).toHaveBeenCalledWith("/my/path");
    expect(result).toContain("in_progress");
    expect(result).toContain("42%");
    expect(result).toContain("80/100"); // matched/total
    expect(result).toContain("150 files");
  });

  it("should show completed enrichment without track-progress hint", async () => {
    const mockGetStatus = vi.fn().mockResolvedValue({
      enrichment: {
        status: "completed",
        matchedFiles: 100,
        missedFiles: 0,
      },
    });

    const result = await formatEnrichmentStatus("background", undefined, mockGetStatus, "/my/path");
    expect(result).toContain("completed");
    expect(result).not.toContain("get_index_status to track progress");
  });

  it("should show low-coverage hint when rate < 80%", async () => {
    const mockGetStatus = vi.fn().mockResolvedValue({
      enrichment: {
        status: "completed",
        matchedFiles: 30,
        missedFiles: 70,
      },
    });

    const result = await formatEnrichmentStatus("background", undefined, mockGetStatus, "/my/path");
    expect(result).toContain("30%");
    expect(result).toContain("Hint:");
    expect(result).toContain("GIT_LOG_MAX_AGE_MONTHS");
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
      expect(result).toContain("File signals:");
      expect(result).toContain("1234");
      expect(result).toContain("3.1s");
      expect(result).toContain("Chunk signals:");
      expect(result).toContain("2.1s");
    });

    it("should omit chunk signals line when chunkChurnDurationMs is 0", async () => {
      const noChunkMetrics = { ...metrics, chunkChurnDurationMs: 0 };
      const result = await formatEnrichmentStatus("completed", 5200, undefined, "", noChunkMetrics);
      expect(result).toContain("File signals:");
      expect(result).not.toContain("Chunk signals:");
    });

    it("should show metrics for background status too", async () => {
      const mockGetStatus = vi.fn().mockResolvedValue({
        enrichment: { status: "in_progress", percentage: 50 },
      });
      const result = await formatEnrichmentStatus("background", undefined, mockGetStatus, "/path", metrics);
      expect(result).toContain("File signals:");
    });
  });
});
