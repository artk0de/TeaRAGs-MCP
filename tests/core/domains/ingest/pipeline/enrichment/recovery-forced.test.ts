import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentRecovery } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/recovery.js";

/**
 * Forced recompute reuses recovery's traversal but widens the candidate set:
 * recovery heals what is MISSING, a recompute rebuilds what is already THERE.
 * The only difference is the Qdrant filter, so these tests pin the filter.
 */
describe("EnrichmentRecovery — forced recompute scope", () => {
  let mockQdrant: {
    scrollFiltered: ReturnType<typeof vi.fn>;
    setPayload: ReturnType<typeof vi.fn>;
    batchSetPayload: ReturnType<typeof vi.fn>;
    countPoints: ReturnType<typeof vi.fn>;
  };
  let mockProvider: {
    key: string;
    resolveRoot: ReturnType<typeof vi.fn>;
    buildFileSignals: ReturnType<typeof vi.fn>;
    buildChunkSignals: ReturnType<typeof vi.fn>;
    fileSignalTransform: undefined;
  };
  let mockApplier: {
    applyFileSignals: ReturnType<typeof vi.fn>;
    applyChunkSignals: ReturnType<typeof vi.fn>;
    applySkipStamps: ReturnType<typeof vi.fn>;
  };
  let recovery: EnrichmentRecovery;

  beforeEach(() => {
    mockQdrant = {
      scrollFiltered: vi.fn().mockResolvedValue([]),
      setPayload: vi.fn().mockResolvedValue(undefined),
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      countPoints: vi.fn().mockResolvedValue(0),
    };
    mockProvider = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
      fileSignalTransform: undefined,
    };
    mockApplier = {
      applyFileSignals: vi.fn().mockResolvedValue(undefined),
      applyChunkSignals: vi.fn().mockResolvedValue(0),
      applySkipStamps: vi.fn().mockResolvedValue(undefined),
    };
    recovery = new EnrichmentRecovery(mockQdrant as never, mockApplier as never);
  });

  function filterOfFirstScroll(): { must?: unknown[]; must_not?: unknown[] } {
    return mockQdrant.scrollFiltered.mock.calls[0][1] as { must?: unknown[]; must_not?: unknown[] };
  }

  it("stops filtering on enrichedAt so already-enriched points are recomputed", async () => {
    await recovery.recoverFileLevel("c", "/repo", mockProvider as never, "2026-01-01T00:00:00Z", "all");

    const filter = filterOfFirstScroll();
    expect(JSON.stringify(filter.must ?? [])).not.toContain("enrichedAt");
  });

  it("stops filtering on skippedAs so previously stamped points are revisited", async () => {
    await recovery.recoverFileLevel("c", "/repo", mockProvider as never, "2026-01-01T00:00:00Z", "all");

    const filter = filterOfFirstScroll();
    expect(JSON.stringify(filter.must ?? [])).not.toContain("skippedAs");
  });

  it("still excludes metadata points and points with no relativePath", async () => {
    // These exclusions are not about staleness — such points cannot be
    // enriched at all, so widening the scope must not pull them in.
    await recovery.recoverFileLevel("c", "/repo", mockProvider as never, "2026-01-01T00:00:00Z", "all");

    const serialized = JSON.stringify(filterOfFirstScroll().must_not ?? []);
    expect(serialized).toContain("indexing_metadata");
    expect(serialized).toContain("schema_metadata");
    expect(serialized).toContain("relativePath");
  });

  it("keeps the unenriched-only filter when no scope is given", async () => {
    await recovery.recoverFileLevel("c", "/repo", mockProvider as never, "2026-01-01T00:00:00Z");

    expect(JSON.stringify(filterOfFirstScroll().must ?? [])).toContain("enrichedAt");
  });

  it("recomputes chunk level over the widened set too", async () => {
    await recovery.recoverChunkLevel("c", "/repo", mockProvider as never, "2026-01-01T00:00:00Z", "all");

    expect(JSON.stringify(filterOfFirstScroll().must ?? [])).not.toContain("enrichedAt");
  });

  it("re-enriches a point that already carries an enrichedAt stamp", async () => {
    mockQdrant.scrollFiltered.mockResolvedValue([
      {
        id: "chunk-1",
        payload: { relativePath: "src/foo.ts", startLine: 1, endLine: 10 },
      },
    ]);

    const result = await recovery.recoverFileLevel("c", "/repo", mockProvider as never, "2026-01-01T00:00:00Z", "all");

    expect(mockProvider.buildFileSignals).toHaveBeenCalled();
    expect(result.recoveredChunks).toBe(1);
  });

  it("leaves policy-declined files alone even under a forced recompute", async () => {
    // A generated file is unenriched BY DESIGN. Forcing a recompute must not
    // turn a deliberate policy skip into work.
    const decliningProvider = {
      ...mockProvider,
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      shouldEnrich: vi.fn().mockReturnValue("none"),
    };
    mockQdrant.scrollFiltered.mockResolvedValue([
      { id: "chunk-1", payload: { relativePath: "dist/bundle.js", startLine: 1, endLine: 10 } },
    ]);

    const result = await recovery.recoverFileLevel(
      "c",
      "/repo",
      decliningProvider as never,
      "2026-01-01T00:00:00Z",
      "all",
    );

    expect(decliningProvider.buildFileSignals).not.toHaveBeenCalled();
    expect(result.recoveredChunks).toBe(0);
  });
});
