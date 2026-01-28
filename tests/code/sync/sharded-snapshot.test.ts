/**
 * Tests for ShardedSnapshotManager - sharded snapshot storage with atomic writes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShardedSnapshotManager } from "../../../src/code/sync/sharded-snapshot.js";
import type { FileMetadata } from "../../../src/code/sync/sharded-snapshot.js";

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
    // Cleanup
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("save and load", () => {
    it("should save files to sharded structure", async () => {
      const files = new Map<string, FileMetadata>([
        ["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a" }],
        ["src/b.ts", { mtime: 2000, size: 200, hash: "hash-b" }],
        ["lib/c.ts", { mtime: 3000, size: 300, hash: "hash-c" }],
      ]);

      await manager.save("/test/codebase", files);

      // Check structure exists
      const snapshotDir = join(testDir, "test-collection");
      const metaExists = await fileExists(join(snapshotDir, "meta.json"));
      expect(metaExists).toBe(true);

      // At least one shard should exist
      const shard0Exists = await fileExists(join(snapshotDir, "shard-00.json"));
      expect(shard0Exists).toBe(true);
    });

    it("should load saved files correctly", async () => {
      const files = new Map<string, FileMetadata>([
        ["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a" }],
        ["src/b.ts", { mtime: 2000, size: 200, hash: "hash-b" }],
        ["lib/c.ts", { mtime: 3000, size: 300, hash: "hash-c" }],
      ]);

      await manager.save("/test/codebase", files);
      const loaded = await manager.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.codebasePath).toBe("/test/codebase");
      expect(loaded!.files.size).toBe(3);
      expect(loaded!.files.get("src/a.ts")).toEqual({ mtime: 1000, size: 100, hash: "hash-a" });
      expect(loaded!.files.get("src/b.ts")).toEqual({ mtime: 2000, size: 200, hash: "hash-b" });
      expect(loaded!.files.get("lib/c.ts")).toEqual({ mtime: 3000, size: 300, hash: "hash-c" });
    });

    it("should return null when no snapshot exists", async () => {
      const loaded = await manager.load();
      expect(loaded).toBeNull();
    });

    it("should handle empty file map", async () => {
      const files = new Map<string, FileMetadata>();

      await manager.save("/test/codebase", files);
      const loaded = await manager.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.files.size).toBe(0);
    });
  });

  describe("atomic writes", () => {
    it("should use temp directory during write", async () => {
      const files = new Map<string, FileMetadata>([
        ["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a" }],
      ]);

      // After save, no temp directories should remain
      await manager.save("/test/codebase", files);

      const entries = await fs.readdir(testDir);
      const tempDirs = entries.filter(e => e.includes(".tmp."));
      expect(tempDirs).toHaveLength(0);
    });

    it("should cleanup stale temp directories on save", async () => {
      // Create a stale temp directory
      const staleTempDir = join(testDir, "test-collection.tmp.123456");
      await fs.mkdir(staleTempDir, { recursive: true });
      await fs.writeFile(join(staleTempDir, "meta.json"), "{}");

      const files = new Map<string, FileMetadata>([
        ["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a" }],
      ]);

      await manager.save("/test/codebase", files);

      // Stale temp should be cleaned up
      const staleTempExists = await fileExists(staleTempDir);
      expect(staleTempExists).toBe(false);
    });
  });

  describe("checksum validation", () => {
    it("should detect corrupted shard via checksum", async () => {
      const files = new Map<string, FileMetadata>([
        ["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a" }],
      ]);

      await manager.save("/test/codebase", files);

      // Corrupt shard file
      const snapshotDir = join(testDir, "test-collection");
      const shardPath = join(snapshotDir, "shard-00.json");

      if (await fileExists(shardPath)) {
        await fs.appendFile(shardPath, "corruption");
      } else {
        // Find the shard that has the file
        const entries = await fs.readdir(snapshotDir);
        const shardFile = entries.find(e => e.startsWith("shard-") && e.endsWith(".json"));
        if (shardFile) {
          await fs.appendFile(join(snapshotDir, shardFile), "corruption");
        }
      }

      await expect(manager.load()).rejects.toThrow(/checksum/i);
    });

    it("should validate meta.json integrity", async () => {
      const files = new Map<string, FileMetadata>([
        ["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a" }],
      ]);

      await manager.save("/test/codebase", files);

      // Corrupt meta.json
      const metaPath = join(testDir, "test-collection", "meta.json");
      await fs.appendFile(metaPath, "corruption");

      await expect(manager.load()).rejects.toThrow();
    });
  });

  describe("merkle tree", () => {
    it("should compute shard merkle roots", async () => {
      const files = new Map<string, FileMetadata>([
        ["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a" }],
        ["src/b.ts", { mtime: 2000, size: 200, hash: "hash-b" }],
      ]);

      await manager.save("/test/codebase", files);
      const loaded = await manager.load();

      expect(loaded!.shardMerkleRoots.length).toBeGreaterThan(0);
      expect(loaded!.metaRootHash).toBeDefined();
      expect(loaded!.metaRootHash.length).toBe(64); // SHA256 hex
    });

    it("should detect changes via meta root hash", async () => {
      const files1 = new Map<string, FileMetadata>([
        ["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a" }],
      ]);

      await manager.save("/test/codebase", files1);
      const loaded1 = await manager.load();

      const files2 = new Map<string, FileMetadata>([
        ["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a-modified" }],
      ]);

      await manager.save("/test/codebase", files2);
      const loaded2 = await manager.load();

      expect(loaded1!.metaRootHash).not.toBe(loaded2!.metaRootHash);
    });
  });

  describe("shard distribution", () => {
    it("should distribute files across multiple shards", async () => {
      // Create many files to ensure distribution
      const files = new Map<string, FileMetadata>();
      for (let i = 0; i < 100; i++) {
        files.set(`src/file-${i}.ts`, { mtime: i * 1000, size: i * 10, hash: `hash-${i}` });
      }

      await manager.save("/test/codebase", files);

      // Check multiple shards exist
      const snapshotDir = join(testDir, "test-collection");
      const entries = await fs.readdir(snapshotDir);
      const shardFiles = entries.filter(e => e.startsWith("shard-") && e.endsWith(".json"));

      // With 100 files and 4 shards, should have multiple shards
      expect(shardFiles.length).toBeGreaterThan(1);
    });
  });

  describe("exists and delete", () => {
    it("should check if snapshot exists", async () => {
      expect(await manager.exists()).toBe(false);

      const files = new Map<string, FileMetadata>([
        ["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a" }],
      ]);
      await manager.save("/test/codebase", files);

      expect(await manager.exists()).toBe(true);
    });

    it("should delete snapshot", async () => {
      const files = new Map<string, FileMetadata>([
        ["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a" }],
      ]);
      await manager.save("/test/codebase", files);

      await manager.delete();

      expect(await manager.exists()).toBe(false);
    });
  });
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
