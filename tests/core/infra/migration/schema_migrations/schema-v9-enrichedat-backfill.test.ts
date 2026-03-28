import { beforeEach, describe, expect, it, vi } from "vitest";

import { SchemaV9EnrichedAtBackfill } from "../../../../../src/core/infra/migration/schema_migrations/schema-v9-enrichedat-backfill.js";
import type { EnrichmentStore } from "../../../../../src/core/infra/migration/types.js";

describe("SchemaV9EnrichedAtBackfill", () => {
  let mockStore: {
    isMigrated: ReturnType<typeof vi.fn>;
    scrollAllChunks: ReturnType<typeof vi.fn>;
    batchSetPayload: ReturnType<typeof vi.fn>;
    markMigrated: ReturnType<typeof vi.fn>;
  };
  let migration: SchemaV9EnrichedAtBackfill;

  beforeEach(() => {
    mockStore = {
      isMigrated: vi.fn().mockResolvedValue(false),
      scrollAllChunks: vi.fn().mockResolvedValue([]),
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      markMigrated: vi.fn().mockResolvedValue(undefined),
    };
    migration = new SchemaV9EnrichedAtBackfill("test-collection", mockStore as EnrichmentStore, "git");
  });

  it("has correct name and version", () => {
    expect(migration.name).toBe("schema-v9-enrichedat-backfill");
    expect(migration.version).toBe(9);
  });

  it("sets git.file.enrichedAt for chunks with git.file.commitCount", async () => {
    mockStore.scrollAllChunks.mockResolvedValue([
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

    const result = await migration.apply();

    expect(mockStore.batchSetPayload).toHaveBeenCalled();
    const calls = mockStore.batchSetPayload.mock.calls[0][1] as {
      payload: Record<string, unknown>;
      points: string[];
      key?: string;
    }[];
    const fileOps = calls.filter((op) => op.key === "git.file" && "enrichedAt" in op.payload);
    expect(fileOps.length).toBeGreaterThan(0);
    const allPoints = fileOps.flatMap((op) => op.points);
    expect(allPoints).toContain("chunk-1");
    expect(allPoints).toContain("chunk-2");
    expect(result.applied.length).toBe(1);
    expect(result.applied[0]).toContain("enrichedAt backfill");
  });

  it("sets git.chunk.enrichedAt for chunks with git.chunk.commitCount", async () => {
    mockStore.scrollAllChunks.mockResolvedValue([
      {
        id: "chunk-3",
        payload: {
          relativePath: "src/c.ts",
          git: { chunk: { commitCount: 2 } },
        },
      },
    ]);

    await migration.apply();

    expect(mockStore.batchSetPayload).toHaveBeenCalled();
    const calls = mockStore.batchSetPayload.mock.calls[0][1] as {
      payload: Record<string, unknown>;
      points: string[];
      key?: string;
    }[];
    const chunkOps = calls.filter((op) => op.key === "git.chunk" && "enrichedAt" in op.payload);
    expect(chunkOps.length).toBeGreaterThan(0);
    const allPoints = chunkOps.flatMap((op) => op.points);
    expect(allPoints).toContain("chunk-3");
  });

  it("does NOT set enrichedAt for chunks without git signals", async () => {
    mockStore.scrollAllChunks.mockResolvedValue([
      {
        id: "chunk-no-git",
        payload: { relativePath: "src/d.ts" },
      },
    ]);

    await migration.apply();

    if (mockStore.batchSetPayload.mock.calls.length > 0) {
      const calls = mockStore.batchSetPayload.mock.calls[0][1] as {
        payload: Record<string, unknown>;
        points: string[];
      }[];
      const allPoints = calls.flatMap((op) => op.points);
      expect(allPoints).not.toContain("chunk-no-git");
    }
  });

  it("skips migration if already migrated", async () => {
    mockStore.isMigrated.mockResolvedValue(true);

    const result = await migration.apply();

    expect(mockStore.scrollAllChunks).not.toHaveBeenCalled();
    expect(mockStore.batchSetPayload).not.toHaveBeenCalled();
    expect(mockStore.markMigrated).not.toHaveBeenCalled();
    expect(result.applied).toEqual([]);
  });

  it("marks migration as complete after applying", async () => {
    mockStore.scrollAllChunks.mockResolvedValue([
      {
        id: "chunk-1",
        payload: {
          relativePath: "src/a.ts",
          git: { file: { commitCount: 5 } },
        },
      },
    ]);

    await migration.apply();

    expect(mockStore.markMigrated).toHaveBeenCalledWith("test-collection");
  });

  it("marks migration even with zero operations (no chunks with signals)", async () => {
    mockStore.scrollAllChunks.mockResolvedValue([{ id: "chunk-1", payload: { relativePath: "src/a.ts" } }]);

    await migration.apply();

    expect(mockStore.batchSetPayload).not.toHaveBeenCalled();
    expect(mockStore.markMigrated).toHaveBeenCalledWith("test-collection");
  });
});
