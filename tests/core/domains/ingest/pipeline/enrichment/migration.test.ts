import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentMigration } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/migration.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/domains/ingest/constants.js";

describe("EnrichmentMigration", () => {
  let mockQdrant: {
    scrollFiltered: ReturnType<typeof vi.fn>;
    batchSetPayload: ReturnType<typeof vi.fn>;
    getPoint: ReturnType<typeof vi.fn>;
    setPayload: ReturnType<typeof vi.fn>;
  };
  let migration: EnrichmentMigration;

  beforeEach(() => {
    mockQdrant = {
      scrollFiltered: vi.fn().mockResolvedValue([]),
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };
    migration = new EnrichmentMigration(mockQdrant as any);
  });

  it("sets git.file.enrichedAt for chunks with git.file.commitCount", async () => {
    mockQdrant.scrollFiltered.mockResolvedValue([
      {
        id: "chunk-1",
        payload: {
          relativePath: "src/a.ts",
          git: { file: { commitCount: 5, ageDays: 30 } },
        },
      },
      {
        id: "chunk-2",
        payload: {
          relativePath: "src/b.ts",
          git: { file: { commitCount: 3, ageDays: 10 } },
        },
      },
    ]);

    await migration.migrateEnrichedAt("test-collection", "git");

    expect(mockQdrant.batchSetPayload).toHaveBeenCalled();
    const calls = mockQdrant.batchSetPayload.mock.calls[0][1] as {
      payload: Record<string, unknown>;
      points: string[];
    }[];
    const fileOps = calls.filter((op) => "git.file.enrichedAt" in op.payload);
    expect(fileOps.length).toBeGreaterThan(0);
    const allPoints = fileOps.flatMap((op) => op.points);
    expect(allPoints).toContain("chunk-1");
    expect(allPoints).toContain("chunk-2");
  });

  it("sets git.chunk.enrichedAt for chunks with git.chunk.commitCount", async () => {
    mockQdrant.scrollFiltered.mockResolvedValue([
      {
        id: "chunk-3",
        payload: {
          relativePath: "src/c.ts",
          git: { chunk: { commitCount: 2 } },
        },
      },
    ]);

    await migration.migrateEnrichedAt("test-collection", "git");

    expect(mockQdrant.batchSetPayload).toHaveBeenCalled();
    const calls = mockQdrant.batchSetPayload.mock.calls[0][1] as {
      payload: Record<string, unknown>;
      points: string[];
    }[];
    const chunkOps = calls.filter((op) => "git.chunk.enrichedAt" in op.payload);
    expect(chunkOps.length).toBeGreaterThan(0);
    const allPoints = chunkOps.flatMap((op) => op.points);
    expect(allPoints).toContain("chunk-3");
  });

  it("does NOT set enrichedAt for chunks without git signals", async () => {
    mockQdrant.scrollFiltered.mockResolvedValue([
      {
        id: "chunk-no-git",
        payload: {
          relativePath: "src/d.ts",
          // no git signals at all
        },
      },
    ]);

    await migration.migrateEnrichedAt("test-collection", "git");

    // batchSetPayload should not be called for this chunk (or called with empty ops)
    if (mockQdrant.batchSetPayload.mock.calls.length > 0) {
      const calls = mockQdrant.batchSetPayload.mock.calls[0][1] as {
        payload: Record<string, unknown>;
        points: string[];
      }[];
      const allPoints = calls.flatMap((op) => op.points);
      expect(allPoints).not.toContain("chunk-no-git");
    }
  });

  it("skips migration if enrichmentMigrationV1 marker is already set", async () => {
    mockQdrant.getPoint.mockResolvedValue({
      id: INDEXING_METADATA_ID,
      payload: { enrichmentMigrationV1: true },
    });

    await migration.migrateEnrichedAt("test-collection", "git");

    expect(mockQdrant.scrollFiltered).not.toHaveBeenCalled();
    expect(mockQdrant.batchSetPayload).not.toHaveBeenCalled();
    expect(mockQdrant.setPayload).not.toHaveBeenCalled();
  });

  it("writes enrichmentMigrationV1 marker after completing migration", async () => {
    mockQdrant.scrollFiltered.mockResolvedValue([
      {
        id: "chunk-1",
        payload: {
          relativePath: "src/a.ts",
          git: { file: { commitCount: 5 } },
        },
      },
    ]);

    await migration.migrateEnrichedAt("test-collection", "git");

    expect(mockQdrant.setPayload).toHaveBeenCalledWith(
      "test-collection",
      { enrichmentMigrationV1: true },
      { points: [INDEXING_METADATA_ID] },
    );
  });
});
