/**
 * Tests for DIP adapters: SnapshotStoreAdapter, IndexStoreAdapter, SparseStoreAdapter.
 *
 * These adapters bridge infra/migration types to filesystem and Qdrant implementations.
 * Tests verify correct delegation and format detection, not Qdrant or filesystem behavior.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexStoreAdapter } from "../../../../src/core/infra/migration/adapters/index-store-adapter.js";
import { SnapshotStoreAdapter } from "../../../../src/core/infra/migration/adapters/snapshot-store-adapter.js";
import { SparseStoreAdapter } from "../../../../src/core/infra/migration/adapters/sparse-store-adapter.js";

// ── SnapshotStoreAdapter ──────────────────────────────────────────────────────

describe("SnapshotStoreAdapter", () => {
  let snapshotDir: string;
  let adapter: SnapshotStoreAdapter;
  const collectionName = "test_collection";

  beforeEach(async () => {
    snapshotDir = join(tmpdir(), `tea-rags-test-${Date.now()}`);
    await fs.mkdir(snapshotDir, { recursive: true });
    adapter = new SnapshotStoreAdapter(snapshotDir, collectionName);
  });

  afterEach(async () => {
    await fs.rm(snapshotDir, { recursive: true, force: true });
  });

  describe("getFormat", () => {
    it("returns none when no snapshot exists", async () => {
      expect(await adapter.getFormat()).toBe("none");
    });

    it("returns sharded when meta.json exists", async () => {
      const shardedDir = join(snapshotDir, collectionName);
      await fs.mkdir(shardedDir, { recursive: true });
      await fs.writeFile(join(shardedDir, "meta.json"), JSON.stringify({ version: "3" }));
      expect(await adapter.getFormat()).toBe("sharded");
    });

    it("returns v1 for old snapshot without version field", async () => {
      const snapshot = { codebasePath: "/some/path", fileHashes: {}, timestamp: 0, merkleTree: "" };
      await fs.writeFile(join(snapshotDir, `${collectionName}.json`), JSON.stringify(snapshot));
      expect(await adapter.getFormat()).toBe("v1");
    });

    it("returns v2 for snapshot with version '2'", async () => {
      const snapshot = {
        version: "2",
        codebasePath: "/some/path",
        fileHashes: {},
        fileMetadata: {},
        timestamp: 0,
        merkleTree: "",
      };
      await fs.writeFile(join(snapshotDir, `${collectionName}.json`), JSON.stringify(snapshot));
      expect(await adapter.getFormat()).toBe("v2");
    });

    it("returns none when snapshot file is corrupt JSON", async () => {
      await fs.writeFile(join(snapshotDir, `${collectionName}.json`), "invalid json{{{");
      expect(await adapter.getFormat()).toBe("none");
    });
  });

  describe("readV1", () => {
    it("returns null when format is not v1", async () => {
      // No file = none format
      expect(await adapter.readV1()).toBeNull();
    });

    it("returns fileHashes and codebasePath for v1 snapshot", async () => {
      const snapshot = {
        codebasePath: "/my/codebase",
        fileHashes: { "src/index.ts": "abc123" },
        timestamp: 0,
        merkleTree: "",
      };
      await fs.writeFile(join(snapshotDir, `${collectionName}.json`), JSON.stringify(snapshot));
      const result = await adapter.readV1();
      expect(result).not.toBeNull();
      expect(result!.codebasePath).toBe("/my/codebase");
      expect(result!.fileHashes["src/index.ts"]).toBe("abc123");
    });
  });

  describe("readV2", () => {
    it("returns null when format is not v2", async () => {
      expect(await adapter.readV2()).toBeNull();
    });

    it("returns fileMetadata and codebasePath for v2 snapshot", async () => {
      const snapshot = {
        version: "2",
        codebasePath: "/my/codebase",
        fileHashes: {},
        fileMetadata: {
          "src/index.ts": { mtime: 12345, size: 100, hash: "abc" },
        },
        timestamp: 0,
        merkleTree: "",
      };
      await fs.writeFile(join(snapshotDir, `${collectionName}.json`), JSON.stringify(snapshot));
      const result = await adapter.readV2();
      expect(result).not.toBeNull();
      expect(result!.codebasePath).toBe("/my/codebase");
      expect(result!.fileMetadata["src/index.ts"].mtime).toBe(12345);
    });
  });

  describe("writeSharded", () => {
    it("writes sharded snapshot to disk", async () => {
      const files = new Map([["src/index.ts", { mtime: 12345, size: 100, hash: "abc123" }]]);
      await adapter.writeSharded("/my/codebase", files);
      // Verify meta.json was written by ShardedSnapshotManager
      const metaPath = join(snapshotDir, collectionName, "meta.json");
      await expect(fs.access(metaPath)).resolves.toBeUndefined();
    });
  });

  describe("backup", () => {
    it("copies old snapshot to backup path", async () => {
      await fs.writeFile(join(snapshotDir, `${collectionName}.json`), "{}");
      await adapter.backup();
      const backup = join(snapshotDir, `${collectionName}.json.backup`);
      await expect(fs.access(backup)).resolves.toBeUndefined();
    });

    it("is a no-op when old snapshot does not exist", async () => {
      await expect(adapter.backup()).resolves.toBeUndefined();
    });
  });

  describe("deleteOld", () => {
    it("removes old snapshot file", async () => {
      const oldPath = join(snapshotDir, `${collectionName}.json`);
      await fs.writeFile(oldPath, "{}");
      await adapter.deleteOld();
      await expect(fs.access(oldPath)).rejects.toThrow();
    });

    it("is a no-op when old snapshot does not exist", async () => {
      await expect(adapter.deleteOld()).resolves.toBeUndefined();
    });
  });

  describe("invalidateByExtensions", () => {
    it("returns 0 when format is not sharded", async () => {
      // No sharded snapshot exists → format is "none"
      const count = await adapter.invalidateByExtensions([".md"]);
      expect(count).toBe(0);
    });

    it("invalidates matching files in sharded snapshot", async () => {
      // Create a sharded snapshot with markdown and non-markdown files
      const files = new Map([
        ["docs/readme.md", { mtime: 1000, size: 100, hash: "abc" }],
        ["docs/guide.markdown", { mtime: 2000, size: 200, hash: "def" }],
        ["src/index.ts", { mtime: 3000, size: 300, hash: "ghi" }],
      ]);
      await adapter.writeSharded("/my/codebase", files);

      const count = await adapter.invalidateByExtensions([".md", ".markdown"]);
      expect(count).toBe(2);
    });

    it("returns 0 when no files match the extensions", async () => {
      const files = new Map([["src/index.ts", { mtime: 1000, size: 100, hash: "abc" }]]);
      await adapter.writeSharded("/my/codebase", files);

      const count = await adapter.invalidateByExtensions([".md"]);
      expect(count).toBe(0);
    });

    it("empties hash for invalidated files so synchronizer detects mismatch", async () => {
      const files = new Map([
        ["docs/readme.md", { mtime: 1000, size: 100, hash: "abc123" }],
        ["src/index.ts", { mtime: 2000, size: 200, hash: "def456" }],
      ]);
      await adapter.writeSharded("/my/codebase", files);

      await adapter.invalidateByExtensions([".md"]);

      // Reload snapshot to verify hash was emptied
      const { ShardedSnapshotManager } = await import("../../../../src/core/domains/ingest/sync/sharded-snapshot.js");
      const manager = new ShardedSnapshotManager(snapshotDir, collectionName);
      const snapshot = await manager.load();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.files.get("docs/readme.md")!.hash).toBe("");
      expect(snapshot!.files.get("src/index.ts")!.hash).toBe("def456");
    });
  });

  describe("statFile", () => {
    it("returns mtime and size for existing file", async () => {
      const filePath = join(snapshotDir, "test.ts");
      await fs.writeFile(filePath, "hello");
      const stat = await adapter.statFile(filePath);
      expect(stat).not.toBeNull();
      expect(stat!.size).toBeGreaterThan(0);
      expect(typeof stat!.mtimeMs).toBe("number");
    });

    it("returns null for missing file", async () => {
      const stat = await adapter.statFile("/non/existent/file.ts");
      expect(stat).toBeNull();
    });
  });
});

// ── IndexStoreAdapter ─────────────────────────────────────────────────────────

describe("IndexStoreAdapter", () => {
  function makeQdrant(overrides: Record<string, unknown> = {}) {
    return {
      getPoint: vi.fn().mockResolvedValue(null),
      hasPayloadIndex: vi.fn().mockResolvedValue(false),
      ensurePayloadIndex: vi.fn().mockResolvedValue(true),
      addPoints: vi.fn().mockResolvedValue(undefined),
      addPointsWithSparse: vi.fn().mockResolvedValue(undefined),
      getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384, hybridEnabled: false }),
      updateCollectionSparseConfig: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  describe("getSchemaVersion", () => {
    it("returns 0 when no metadata point exists and no index", async () => {
      const qdrant = makeQdrant();
      const adapter = new IndexStoreAdapter(qdrant as any);
      expect(await adapter.getSchemaVersion("col")).toBe(0);
    });

    it("returns version from schema_metadata point", async () => {
      const qdrant = makeQdrant({
        getPoint: vi.fn().mockResolvedValue({
          id: "__schema_metadata__",
          payload: { _type: "schema_metadata", schemaVersion: 7 },
        }),
      });
      const adapter = new IndexStoreAdapter(qdrant as any);
      expect(await adapter.getSchemaVersion("col")).toBe(7);
    });

    it("returns 6 when no metadata point but relativePath index exists", async () => {
      const qdrant = makeQdrant({
        hasPayloadIndex: vi.fn().mockResolvedValue(true),
      });
      const adapter = new IndexStoreAdapter(qdrant as any);
      expect(await adapter.getSchemaVersion("col")).toBe(6);
    });

    it("returns 0 on thrown error", async () => {
      const qdrant = makeQdrant({
        getPoint: vi.fn().mockRejectedValue(new Error("network error")),
      });
      const adapter = new IndexStoreAdapter(qdrant as any);
      expect(await adapter.getSchemaVersion("col")).toBe(0);
    });
  });

  describe("ensureIndex", () => {
    it("delegates to qdrant.ensurePayloadIndex", async () => {
      const qdrant = makeQdrant();
      const adapter = new IndexStoreAdapter(qdrant as any);
      const result = await adapter.ensureIndex("col", "relativePath", "keyword");
      expect(qdrant.ensurePayloadIndex).toHaveBeenCalledWith("col", "relativePath", "keyword");
      expect(result).toBe(true);
    });
  });

  describe("storeSchemaVersion", () => {
    it("calls addPoints for non-hybrid collection", async () => {
      const qdrant = makeQdrant();
      const adapter = new IndexStoreAdapter(qdrant as any);
      await adapter.storeSchemaVersion("col", 8, ["relativePath"]);
      expect(qdrant.addPoints).toHaveBeenCalled();
      expect(qdrant.addPointsWithSparse).not.toHaveBeenCalled();
    });

    it("calls addPointsWithSparse for hybrid collection", async () => {
      const qdrant = makeQdrant({
        getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384, hybridEnabled: true }),
      });
      const adapter = new IndexStoreAdapter(qdrant as any);
      await adapter.storeSchemaVersion("col", 8, ["relativePath"]);
      expect(qdrant.addPointsWithSparse).toHaveBeenCalled();
      expect(qdrant.addPoints).not.toHaveBeenCalled();
    });

    it("does not throw on error (non-fatal)", async () => {
      const qdrant = makeQdrant({
        getCollectionInfo: vi.fn().mockRejectedValue(new Error("qdrant down")),
      });
      const adapter = new IndexStoreAdapter(qdrant as any);
      await expect(adapter.storeSchemaVersion("col", 8, [])).resolves.toBeUndefined();
    });
  });

  describe("hasPayloadIndex", () => {
    it("delegates to qdrant.hasPayloadIndex", async () => {
      const qdrant = makeQdrant({ hasPayloadIndex: vi.fn().mockResolvedValue(true) });
      const adapter = new IndexStoreAdapter(qdrant as any);
      expect(await adapter.hasPayloadIndex("col", "language")).toBe(true);
    });
  });

  describe("getCollectionInfo", () => {
    it("returns hybridEnabled and vectorSize", async () => {
      const qdrant = makeQdrant({
        getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 768, hybridEnabled: true }),
      });
      const adapter = new IndexStoreAdapter(qdrant as any);
      const info = await adapter.getCollectionInfo("col");
      expect(info).toEqual({ hybridEnabled: true, vectorSize: 768 });
    });
  });

  describe("updateSparseConfig", () => {
    it("delegates to qdrant.updateCollectionSparseConfig", async () => {
      const qdrant = makeQdrant();
      const adapter = new IndexStoreAdapter(qdrant as any);
      await adapter.updateSparseConfig("col");
      expect(qdrant.updateCollectionSparseConfig).toHaveBeenCalledWith("col");
    });
  });

  describe("deletePointsByFilter", () => {
    it("delegates to qdrant.deletePointsByFilter", async () => {
      const qdrant = makeQdrant({
        deletePointsByFilter: vi.fn().mockResolvedValue(undefined),
      });
      const adapter = new IndexStoreAdapter(qdrant as any);
      const filter = { must: [{ key: "language", match: { value: "markdown" } }] };
      await adapter.deletePointsByFilter("col", filter);
      expect(qdrant.deletePointsByFilter).toHaveBeenCalledWith("col", filter);
    });
  });
});

// ── EnrichmentStoreAdapter ────────────────────────────────────────────────────

describe("EnrichmentStoreAdapter", () => {
  // Dynamically import to avoid issues with module resolution
  async function makeAdapter(overrides: Record<string, unknown> = {}) {
    const { EnrichmentStoreAdapter } =
      await import("../../../../src/core/infra/migration/adapters/enrichment-store-adapter.js");
    const qdrant = {
      getPoint: vi.fn().mockResolvedValue(null),
      scrollFiltered: vi.fn().mockResolvedValue([]),
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    return { adapter: new EnrichmentStoreAdapter(qdrant as any), qdrant };
  }

  describe("isMigrated", () => {
    it("returns false when no metadata point exists", async () => {
      const { adapter } = await makeAdapter();
      expect(await adapter.isMigrated("col")).toBe(false);
    });

    it("returns true when enrichmentMigrationV1 flag is set", async () => {
      const { adapter } = await makeAdapter({
        getPoint: vi.fn().mockResolvedValue({ payload: { enrichmentMigrationV1: true } }),
      });
      expect(await adapter.isMigrated("col")).toBe(true);
    });

    it("returns false when flag is false", async () => {
      const { adapter } = await makeAdapter({
        getPoint: vi.fn().mockResolvedValue({ payload: { enrichmentMigrationV1: false } }),
      });
      expect(await adapter.isMigrated("col")).toBe(false);
    });
  });

  describe("scrollAllChunks", () => {
    it("returns chunks excluding metadata point", async () => {
      const { adapter } = await makeAdapter({
        scrollFiltered: vi.fn().mockResolvedValue([
          { id: "chunk-1", payload: { content: "hello" } },
          { id: "chunk-2", payload: null },
        ]),
      });

      const result = await adapter.scrollAllChunks("col");
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: "chunk-1", payload: { content: "hello" } });
      expect(result[1]).toEqual({ id: "chunk-2", payload: {} }); // null payload defaults to {}
    });
  });

  describe("batchSetPayload", () => {
    it("delegates to qdrant.batchSetPayload", async () => {
      const { adapter, qdrant } = await makeAdapter();
      const operations = [{ payload: { enrichedAt: "2026-01-01" }, points: ["chunk-1"], key: "git.file" }];

      await adapter.batchSetPayload("col", operations);

      expect(qdrant.batchSetPayload).toHaveBeenCalledWith("col", operations);
    });
  });

  describe("markMigrated", () => {
    it("sets enrichmentMigrationV1=true on the metadata point", async () => {
      const { adapter, qdrant } = await makeAdapter();

      await adapter.markMigrated("col");

      expect(qdrant.setPayload).toHaveBeenCalledWith(
        "col",
        { enrichmentMigrationV1: true },
        expect.objectContaining({ points: expect.any(Array) }),
      );
    });
  });
});

// ── SparseStoreAdapter ────────────────────────────────────────────────────────

describe("SparseStoreAdapter", () => {
  function makeQdrant(overrides: Record<string, unknown> = {}) {
    return {
      getPoint: vi.fn().mockResolvedValue(null),
      addPoints: vi.fn().mockResolvedValue(undefined),
      addPointsWithSparse: vi.fn().mockResolvedValue(undefined),
      getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384, hybridEnabled: false }),
      scrollWithVectors: vi.fn().mockImplementation(async function* () {
        /* empty generator */
      }),
      ...overrides,
    };
  }

  describe("getSparseVersion", () => {
    it("returns 0 when no metadata point", async () => {
      const qdrant = makeQdrant();
      const adapter = new SparseStoreAdapter(qdrant as any);
      expect(await adapter.getSparseVersion("col")).toBe(0);
    });

    it("returns sparseVersion from metadata point", async () => {
      const qdrant = makeQdrant({
        getPoint: vi.fn().mockResolvedValue({
          payload: { _type: "schema_metadata", sparseVersion: 1 },
        }),
      });
      const adapter = new SparseStoreAdapter(qdrant as any);
      expect(await adapter.getSparseVersion("col")).toBe(1);
    });

    it("returns 0 when metadata exists but has no sparseVersion", async () => {
      const qdrant = makeQdrant({
        getPoint: vi.fn().mockResolvedValue({
          payload: { _type: "schema_metadata", schemaVersion: 8 },
        }),
      });
      const adapter = new SparseStoreAdapter(qdrant as any);
      expect(await adapter.getSparseVersion("col")).toBe(0);
    });

    it("returns 0 on error", async () => {
      const qdrant = makeQdrant({
        getPoint: vi.fn().mockRejectedValue(new Error("network")),
      });
      const adapter = new SparseStoreAdapter(qdrant as any);
      expect(await adapter.getSparseVersion("col")).toBe(0);
    });
  });

  describe("rebuildSparseVectors", () => {
    it("skips metadata points and processes content points", async () => {
      const mockBatch = [
        { id: "meta", payload: { _type: "schema_metadata" }, vector: [0, 0] },
        { id: "chunk1", payload: { _type: "chunk", content: "hello world" }, vector: [1, 2, 3] },
      ];
      const qdrant = makeQdrant({
        scrollWithVectors: vi.fn().mockImplementation(async function* () {
          yield mockBatch;
        }),
      });
      const adapter = new SparseStoreAdapter(qdrant as any);
      await adapter.rebuildSparseVectors("col");
      // addPointsWithSparse called once for the content chunk (not the metadata one)
      expect(qdrant.addPointsWithSparse).toHaveBeenCalledTimes(1);
      const calls = vi.mocked(qdrant.addPointsWithSparse).mock.calls[0][1];
      expect(calls).toHaveLength(1);
      expect(calls[0].id).toBe("chunk1");
    });

    it("skips indexing_metadata points", async () => {
      const mockBatch = [
        { id: "idx-meta", payload: { _type: "indexing_metadata" }, vector: [0, 0] },
        { id: "chunk1", payload: { _type: "chunk", content: "hello world" }, vector: [1, 2, 3] },
      ];
      const qdrant = makeQdrant({
        scrollWithVectors: vi.fn().mockImplementation(async function* () {
          yield mockBatch;
        }),
      });
      const adapter = new SparseStoreAdapter(qdrant as any);
      await adapter.rebuildSparseVectors("col");
      const calls = vi.mocked(qdrant.addPointsWithSparse).mock.calls[0][1];
      expect(calls).toHaveLength(1);
      expect(calls[0].id).toBe("chunk1");
    });

    it("skips points with non-string content", async () => {
      const mockBatch = [{ id: "chunk1", payload: { _type: "chunk", content: 42 }, vector: [1, 2, 3] }];
      const qdrant = makeQdrant({
        scrollWithVectors: vi.fn().mockImplementation(async function* () {
          yield mockBatch;
        }),
      });
      const adapter = new SparseStoreAdapter(qdrant as any);
      await adapter.rebuildSparseVectors("col");
      expect(qdrant.addPointsWithSparse).not.toHaveBeenCalled();
    });

    it("handles empty collection without error", async () => {
      const qdrant = makeQdrant();
      const adapter = new SparseStoreAdapter(qdrant as any);
      await expect(adapter.rebuildSparseVectors("col")).resolves.toBeUndefined();
      expect(qdrant.addPointsWithSparse).not.toHaveBeenCalled();
    });
  });

  describe("storeSparseVersion", () => {
    it("calls addPoints for non-hybrid collection when no existing metadata", async () => {
      const qdrant = makeQdrant();
      const adapter = new SparseStoreAdapter(qdrant as any);
      await adapter.storeSparseVersion("col", 1);
      expect(qdrant.addPoints).toHaveBeenCalled();
    });

    it("calls addPointsWithSparse for hybrid collection", async () => {
      const qdrant = makeQdrant({
        getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384, hybridEnabled: true }),
      });
      const adapter = new SparseStoreAdapter(qdrant as any);
      await adapter.storeSparseVersion("col", 1);
      expect(qdrant.addPointsWithSparse).toHaveBeenCalled();
    });

    it("preserves existing metadata when updating sparse version", async () => {
      const qdrant = makeQdrant({
        getPoint: vi.fn().mockResolvedValue({
          payload: { _type: "schema_metadata", schemaVersion: 8, indexes: ["relativePath"] },
        }),
      });
      const adapter = new SparseStoreAdapter(qdrant as any);
      await adapter.storeSparseVersion("col", 1);
      const { payload } = vi.mocked(qdrant.addPoints).mock.calls[0][1][0];
      expect(payload.schemaVersion).toBe(8);
      expect(payload.sparseVersion).toBe(1);
    });

    it("does not throw on error (non-fatal)", async () => {
      const qdrant = makeQdrant({
        getCollectionInfo: vi.fn().mockRejectedValue(new Error("down")),
      });
      const adapter = new SparseStoreAdapter(qdrant as any);
      await expect(adapter.storeSparseVersion("col", 1)).resolves.toBeUndefined();
    });
  });
});
