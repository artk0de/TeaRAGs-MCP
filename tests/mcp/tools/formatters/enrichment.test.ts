// src/tools/formatters/enrichment.test.ts
import { describe, expect, it, vi } from "vitest";
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
});
