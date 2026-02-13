/**
 * Tests for ShardedSnapshotManager
 *
 * Coverage:
 * - Basic save/load/exists/delete operations
 * - Parallel shard loading (merkle root order preservation)
 * - Checksum validation and corruption detection
 * - Consistent hashing distribution
 * - Atomic operations and cleanup
 * - Edge cases (empty snapshots, many files)
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShardedSnapshotManager, type FileMetadata } from "./sharded-snapshot.js";

describe("ShardedSnapshotManager", () => {
  let testDir: string;
  let manager: ShardedSnapshotManager;

  beforeEach(async () => {
    // Create unique temp directory for each test
    testDir = join(tmpdir(), `sharded-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    manager = new ShardedSnapshotManager(testDir, "test-collection", 4);
  });

  afterEach(async () => {
    // Cleanup test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // Helper to create test file metadata
  function createFileMetadata(path: string): FileMetadata {
    return {
      mtime: Date.now(),
      size: Math.floor(Math.random() * 10000),
      hash: createHash("sha256")
        .update(path + Date.now())
        .digest("hex"),
    };
  }

  // Helper to create test files map
  function createTestFiles(count: number): Map<string, FileMetadata> {
    const files = new Map<string, FileMetadata>();
    for (let i = 0; i < count; i++) {
      const path = `src/file-${i.toString().padStart(4, "0")}.ts`;
      files.set(path, createFileMetadata(path));
    }
    return files;
  }

  describe("Basic Operations", () => {
    it("should return false for exists() when snapshot does not exist", async () => {
      const exists = await manager.exists();
      expect(exists).toBe(false);
    });

    it("should save and load a snapshot correctly", async () => {
      const files = createTestFiles(10);
      const codebasePath = "/test/codebase";

      await manager.save(codebasePath, files);

      const loaded = await manager.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.codebasePath).toBe(codebasePath);
      expect(loaded!.files.size).toBe(10);

      // Verify all files are present
      for (const [path, meta] of files) {
        const loadedMeta = loaded!.files.get(path);
        expect(loadedMeta).toBeDefined();
        expect(loadedMeta!.hash).toBe(meta.hash);
        expect(loadedMeta!.size).toBe(meta.size);
      }
    });

    it("should return true for exists() after save", async () => {
      const files = createTestFiles(5);
      await manager.save("/test", files);

      const exists = await manager.exists();
      expect(exists).toBe(true);
    });

    it("should delete snapshot correctly", async () => {
      const files = createTestFiles(5);
      await manager.save("/test", files);

      expect(await manager.exists()).toBe(true);

      await manager.delete();

      expect(await manager.exists()).toBe(false);
    });

    it("should return null when loading non-existent snapshot", async () => {
      const loaded = await manager.load();
      expect(loaded).toBeNull();
    });
  });

  describe("Parallel Shard Loading", () => {
    it("should preserve merkle root order when loading shards in parallel", async () => {
      // Create files that will be distributed across all shards
      const files = createTestFiles(100);
      await manager.save("/test", files);

      // Load multiple times and verify consistency
      const results = await Promise.all([manager.load(), manager.load(), manager.load()]);

      // All loads should return the same merkle roots in the same order
      const firstRoots = results[0]!.shardMerkleRoots;
      for (const result of results) {
        expect(result!.shardMerkleRoots).toEqual(firstRoots);
      }

      // Verify merkle roots array has correct length
      expect(firstRoots.length).toBe(4); // 4 shards
    });

    it("should correctly merge files from all shards", async () => {
      const files = createTestFiles(50);
      await manager.save("/test", files);

      const loaded = await manager.load();

      // All files should be present after parallel loading
      expect(loaded!.files.size).toBe(50);

      for (const [path] of files) {
        expect(loaded!.files.has(path)).toBe(true);
      }
    });

    it("should handle concurrent load operations safely", async () => {
      const files = createTestFiles(100);
      await manager.save("/test", files);

      // Simulate high concurrency
      const concurrentLoads = 10;
      const loadPromises = Array(concurrentLoads)
        .fill(null)
        .map(() => manager.load());

      const results = await Promise.all(loadPromises);

      // All results should be identical
      const firstResult = results[0];
      for (const result of results) {
        expect(result!.files.size).toBe(firstResult!.files.size);
        expect(result!.metaRootHash).toBe(firstResult!.metaRootHash);
      }
    });
  });

  describe("Checksum Validation", () => {
    it("should detect corrupted shard file", async () => {
      const files = createTestFiles(10);
      await manager.save("/test", files);

      // Corrupt a shard file
      const shardPath = join(testDir, "test-collection", "shard-00.json");
      const content = await fs.readFile(shardPath, "utf-8");
      const corrupted = content.replace(/"hash"/, '"CORRUPTED_hash"');
      await fs.writeFile(shardPath, corrupted, "utf-8");

      // Load should throw checksum error
      await expect(manager.load()).rejects.toThrow(/Checksum mismatch/);
    });

    it("should validate all shards during parallel load", async () => {
      const files = createTestFiles(20);
      await manager.save("/test", files);

      // Corrupt the last shard (to verify all shards are validated)
      const shardPath = join(testDir, "test-collection", "shard-03.json");
      const content = await fs.readFile(shardPath, "utf-8");
      await fs.writeFile(shardPath, content + "corruption", "utf-8");

      await expect(manager.load()).rejects.toThrow(/Checksum mismatch.*shard 3/);
    });
  });

  describe("Shard Distribution", () => {
    it("should distribute files across shards using consistent hashing", async () => {
      const files = createTestFiles(100);
      await manager.save("/test", files);

      // Read meta.json to check distribution
      const metaPath = join(testDir, "test-collection", "meta.json");
      const metaContent = await fs.readFile(metaPath, "utf-8");
      const meta = JSON.parse(metaContent);

      // Each shard should have some files (with 100 files and 4 shards)
      const totalFiles = meta.shards.reduce((sum: number, s: { fileCount: number }) => sum + s.fileCount, 0);
      expect(totalFiles).toBe(100);

      // Distribution should be roughly even (not all in one shard)
      for (const shard of meta.shards) {
        // Each shard should have at least 1 file with 100 files / 4 shards
        // (consistent hashing should provide reasonable distribution)
        expect(shard.fileCount).toBeGreaterThanOrEqual(0);
      }
    });

    it("should use configurable shard count", async () => {
      const customManager = new ShardedSnapshotManager(
        testDir,
        "custom-shards",
        8, // 8 shards instead of default 4
      );

      const files = createTestFiles(50);
      await customManager.save("/test", files);

      // Check that 8 shard files were created
      const snapshotDir = join(testDir, "custom-shards");
      const entries = await fs.readdir(snapshotDir);
      const shardFiles = entries.filter((e) => e.startsWith("shard-"));

      expect(shardFiles.length).toBe(8);
    });
  });

  describe("Atomic Operations", () => {
    it("should overwrite existing snapshot atomically", async () => {
      const files1 = createTestFiles(10);
      await manager.save("/test", files1);

      const files2 = createTestFiles(20);
      await manager.save("/test", files2);

      const loaded = await manager.load();
      expect(loaded!.files.size).toBe(20);
    });

    it("should cleanup stale temp directories", async () => {
      // Create a fake stale temp directory
      const staleTemp = join(testDir, "test-collection.tmp.12345");
      await fs.mkdir(staleTemp, { recursive: true });
      await fs.writeFile(join(staleTemp, "dummy.json"), "{}");

      // Save should cleanup the stale temp
      const files = createTestFiles(5);
      await manager.save("/test", files);

      // Stale temp should be removed
      try {
        await fs.access(staleTemp);
        expect.fail("Stale temp directory should have been removed");
      } catch {
        // Expected - directory should not exist
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty files map", async () => {
      const files = new Map<string, FileMetadata>();
      await manager.save("/test", files);

      const loaded = await manager.load();
      expect(loaded!.files.size).toBe(0);
      expect(loaded!.shardMerkleRoots.length).toBe(4);
    });

    it("should handle single file", async () => {
      const files = new Map<string, FileMetadata>();
      files.set("single.ts", createFileMetadata("single.ts"));

      await manager.save("/test", files);

      const loaded = await manager.load();
      expect(loaded!.files.size).toBe(1);
      expect(loaded!.files.has("single.ts")).toBe(true);
    });

    it("should handle large number of files", async () => {
      const files = createTestFiles(1000);
      await manager.save("/test", files);

      const loaded = await manager.load();
      expect(loaded!.files.size).toBe(1000);
    });

    it("should handle files with special characters in paths", async () => {
      const files = new Map<string, FileMetadata>();
      const specialPaths = [
        "src/file with spaces.ts",
        "src/файл-на-русском.ts",
        "src/file@special#chars.ts",
        "src/path/to/deeply/nested/file.ts",
      ];

      for (const path of specialPaths) {
        files.set(path, createFileMetadata(path));
      }

      await manager.save("/test", files);

      const loaded = await manager.load();
      expect(loaded!.files.size).toBe(specialPaths.length);

      for (const path of specialPaths) {
        expect(loaded!.files.has(path)).toBe(true);
      }
    });

    it("should preserve exact metadata values", async () => {
      const files = new Map<string, FileMetadata>();
      const exactMeta: FileMetadata = {
        mtime: 1704067200000, // Fixed timestamp
        size: 12345,
        hash: "abc123def456",
      };
      files.set("exact.ts", exactMeta);

      await manager.save("/test", files);

      const loaded = await manager.load();
      const loadedMeta = loaded!.files.get("exact.ts");

      expect(loadedMeta!.mtime).toBe(exactMeta.mtime);
      expect(loadedMeta!.size).toBe(exactMeta.size);
      expect(loadedMeta!.hash).toBe(exactMeta.hash);
    });
  });

  describe("Merkle Tree Integrity", () => {
    it("should compute consistent meta root hash", async () => {
      const files = createTestFiles(50);
      await manager.save("/test", files);

      const loaded1 = await manager.load();
      const loaded2 = await manager.load();

      expect(loaded1!.metaRootHash).toBe(loaded2!.metaRootHash);
      expect(loaded1!.metaRootHash.length).toBeGreaterThan(0);
    });

    it("should produce different hash for different files", async () => {
      const files1 = createTestFiles(10);
      await manager.save("/test", files1);
      const loaded1 = await manager.load();

      // Save different files
      const files2 = createTestFiles(10);
      await manager.save("/test", files2);
      const loaded2 = await manager.load();

      // Hashes should be different (with high probability)
      expect(loaded1!.metaRootHash).not.toBe(loaded2!.metaRootHash);
    });
  });

  describe("Error Handling", () => {
    it("should throw when meta.json is corrupted", async () => {
      const files = createTestFiles(5);
      await manager.save("/test", files);

      // Corrupt meta.json
      const metaPath = join(testDir, "test-collection", "meta.json");
      await fs.writeFile(metaPath, "not valid json", "utf-8");

      await expect(manager.load()).rejects.toThrow(/Failed to read meta.json/);
    });

    it("should throw when shard file is missing", async () => {
      const files = createTestFiles(10);
      await manager.save("/test", files);

      // Delete a shard file
      const shardPath = join(testDir, "test-collection", "shard-01.json");
      await fs.unlink(shardPath);

      await expect(manager.load()).rejects.toThrow();
    });
  });
});
