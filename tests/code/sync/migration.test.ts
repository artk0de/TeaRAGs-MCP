/**
 * Tests for snapshot migration v2 → v3
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SnapshotMigrator } from "../../../src/code/sync/migration.js";
import { ShardedSnapshotManager } from "../../../src/code/sync/sharded-snapshot.js";

describe("SnapshotMigrator", () => {
  let testDir: string;
  let snapshotDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    const baseDir = join(tmpdir(), `migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testDir = baseDir;
    snapshotDir = join(baseDir, "snapshots");
    codebaseDir = join(baseDir, "codebase");

    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.mkdir(codebaseDir, { recursive: true });

    // Create test files in codebase
    await fs.mkdir(join(codebaseDir, "src"), { recursive: true });
    await fs.writeFile(join(codebaseDir, "src", "a.ts"), "const a = 1;");
    await fs.writeFile(join(codebaseDir, "src", "b.ts"), "const b = 2;");
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe("needsMigration", () => {
    it("should return false when no snapshot exists", async () => {
      const migrator = new SnapshotMigrator(snapshotDir, "test-collection", codebaseDir);
      expect(await migrator.needsMigration()).toBe(false);
    });

    it("should return true for v2 snapshot", async () => {
      // Create v2 snapshot
      const v2Snapshot = {
        version: "2",
        codebasePath: codebaseDir,
        timestamp: Date.now(),
        fileHashes: {
          "src/a.ts": "hash-a",
          "src/b.ts": "hash-b",
        },
        fileMetadata: {
          "src/a.ts": { mtime: 1000, size: 100, hash: "hash-a" },
          "src/b.ts": { mtime: 2000, size: 200, hash: "hash-b" },
        },
        merkleTree: '{"root":null}',
      };

      await fs.writeFile(join(snapshotDir, "test-collection.json"), JSON.stringify(v2Snapshot, null, 2));

      const migrator = new SnapshotMigrator(snapshotDir, "test-collection", codebaseDir);
      expect(await migrator.needsMigration()).toBe(true);
    });

    it("should return true for v1 snapshot", async () => {
      // Create v1 snapshot (no version field, no fileMetadata)
      const v1Snapshot = {
        codebasePath: codebaseDir,
        timestamp: Date.now(),
        fileHashes: {
          "src/a.ts": "hash-a",
          "src/b.ts": "hash-b",
        },
        merkleTree: '{"root":null}',
      };

      await fs.writeFile(join(snapshotDir, "test-collection.json"), JSON.stringify(v1Snapshot, null, 2));

      const migrator = new SnapshotMigrator(snapshotDir, "test-collection", codebaseDir);
      expect(await migrator.needsMigration()).toBe(true);
    });

    it("should return false for v3 snapshot (sharded)", async () => {
      // Create v3 sharded snapshot using ShardedSnapshotManager
      const manager = new ShardedSnapshotManager(snapshotDir, "test-collection", 4);
      const files = new Map([["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a" }]]);
      await manager.save(codebaseDir, files);

      const migrator = new SnapshotMigrator(snapshotDir, "test-collection", codebaseDir);
      expect(await migrator.needsMigration()).toBe(false);
    });
  });

  describe("migrate", () => {
    it("should migrate v2 snapshot to v3", async () => {
      // Create v2 snapshot
      const v2Snapshot = {
        version: "2",
        codebasePath: codebaseDir,
        timestamp: Date.now(),
        fileHashes: {
          "src/a.ts": "hash-a",
          "src/b.ts": "hash-b",
        },
        fileMetadata: {
          "src/a.ts": { mtime: 1000, size: 100, hash: "hash-a" },
          "src/b.ts": { mtime: 2000, size: 200, hash: "hash-b" },
        },
        merkleTree: '{"root":null}',
      };

      const v2Path = join(snapshotDir, "test-collection.json");
      await fs.writeFile(v2Path, JSON.stringify(v2Snapshot, null, 2));

      // Migrate
      const migrator = new SnapshotMigrator(snapshotDir, "test-collection", codebaseDir, 4);
      const result = await migrator.migrate();

      expect(result.success).toBe(true);
      expect(result.filesCount).toBe(2);

      // Old v2 file should be removed
      expect(await fileExists(v2Path)).toBe(false);

      // New v3 structure should exist
      const v3Dir = join(snapshotDir, "test-collection");
      expect(await fileExists(join(v3Dir, "meta.json"))).toBe(true);

      // Verify data integrity
      const manager = new ShardedSnapshotManager(snapshotDir, "test-collection", 4);
      const loaded = await manager.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.files.size).toBe(2);
      expect(loaded!.files.get("src/a.ts")?.hash).toBe("hash-a");
      expect(loaded!.files.get("src/b.ts")?.hash).toBe("hash-b");
    });

    it("should migrate v1 snapshot to v3", async () => {
      // Create v1 snapshot (no metadata, need to read files)
      const v1Snapshot = {
        codebasePath: codebaseDir,
        timestamp: Date.now(),
        fileHashes: {
          "src/a.ts": "hash-a",
          "src/b.ts": "hash-b",
        },
        merkleTree: '{"root":null}',
      };

      const v1Path = join(snapshotDir, "test-collection.json");
      await fs.writeFile(v1Path, JSON.stringify(v1Snapshot, null, 2));

      // Migrate
      const migrator = new SnapshotMigrator(snapshotDir, "test-collection", codebaseDir, 4);
      const result = await migrator.migrate();

      expect(result.success).toBe(true);
      expect(result.filesCount).toBe(2);

      // Old v1 file should be removed
      expect(await fileExists(v1Path)).toBe(false);

      // Verify v3 structure
      const manager = new ShardedSnapshotManager(snapshotDir, "test-collection", 4);
      const loaded = await manager.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.files.size).toBe(2);
    });

    it("should handle missing files during migration", async () => {
      // Create v2 snapshot with file that doesn't exist
      const v2Snapshot = {
        version: "2",
        codebasePath: codebaseDir,
        timestamp: Date.now(),
        fileHashes: {
          "src/a.ts": "hash-a",
          "src/missing.ts": "hash-missing", // This file doesn't exist
        },
        fileMetadata: {
          "src/a.ts": { mtime: 1000, size: 100, hash: "hash-a" },
          "src/missing.ts": { mtime: 3000, size: 300, hash: "hash-missing" },
        },
        merkleTree: '{"root":null}',
      };

      await fs.writeFile(join(snapshotDir, "test-collection.json"), JSON.stringify(v2Snapshot, null, 2));

      // Migrate should succeed, skipping missing files
      const migrator = new SnapshotMigrator(snapshotDir, "test-collection", codebaseDir, 4);
      const result = await migrator.migrate();

      expect(result.success).toBe(true);
      expect(result.filesCount).toBe(1); // Only existing file
      expect(result.skippedCount).toBe(1); // Missing file skipped
    });

    it("should not migrate if no old snapshot exists", async () => {
      const migrator = new SnapshotMigrator(snapshotDir, "test-collection", codebaseDir, 4);
      const result = await migrator.migrate();

      expect(result.success).toBe(true);
      expect(result.filesCount).toBe(0);
      expect(result.alreadyMigrated).toBe(true);
    });

    it("should backup old snapshot before migration", async () => {
      // Create v2 snapshot
      const v2Snapshot = {
        version: "2",
        codebasePath: codebaseDir,
        timestamp: Date.now(),
        fileHashes: { "src/a.ts": "hash-a" },
        fileMetadata: { "src/a.ts": { mtime: 1000, size: 100, hash: "hash-a" } },
        merkleTree: '{"root":null}',
      };

      await fs.writeFile(join(snapshotDir, "test-collection.json"), JSON.stringify(v2Snapshot, null, 2));

      const migrator = new SnapshotMigrator(snapshotDir, "test-collection", codebaseDir, 4);
      await migrator.migrate();

      // Backup should exist
      const backupPath = join(snapshotDir, "test-collection.json.backup");
      expect(await fileExists(backupPath)).toBe(true);
    });
  });

  describe("auto-migration", () => {
    it("should auto-migrate when loading via ShardedSnapshotManager", async () => {
      // Create v2 snapshot
      const v2Snapshot = {
        version: "2",
        codebasePath: codebaseDir,
        timestamp: Date.now(),
        fileHashes: { "src/a.ts": "hash-a" },
        fileMetadata: { "src/a.ts": { mtime: 1000, size: 100, hash: "hash-a" } },
        merkleTree: '{"root":null}',
      };

      await fs.writeFile(join(snapshotDir, "test-collection.json"), JSON.stringify(v2Snapshot, null, 2));

      // Use migrator's ensureMigrated helper
      const migrator = new SnapshotMigrator(snapshotDir, "test-collection", codebaseDir, 4);
      await migrator.ensureMigrated();

      // Now ShardedSnapshotManager should work
      const manager = new ShardedSnapshotManager(snapshotDir, "test-collection", 4);
      const loaded = await manager.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.files.get("src/a.ts")?.hash).toBe("hash-a");
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
