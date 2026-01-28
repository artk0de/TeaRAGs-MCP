/**
 * Tests for parallel file synchronization using sharded snapshots
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParallelFileSynchronizer } from "../../../src/code/sync/parallel-synchronizer.js";

describe("ParallelFileSynchronizer", () => {
  let testDir: string;
  let codebaseDir: string;
  let snapshotDir: string;

  beforeEach(async () => {
    // Create unique temp directories
    const baseDir = join(tmpdir(), `parallel-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testDir = baseDir;
    codebaseDir = join(baseDir, "codebase");
    snapshotDir = join(baseDir, "snapshots");

    await fs.mkdir(codebaseDir, { recursive: true });
    await fs.mkdir(snapshotDir, { recursive: true });

    // Create test files
    await fs.mkdir(join(codebaseDir, "src"), { recursive: true });
    await fs.mkdir(join(codebaseDir, "lib"), { recursive: true });
    await fs.writeFile(join(codebaseDir, "src", "a.ts"), "const a = 1;");
    await fs.writeFile(join(codebaseDir, "src", "b.ts"), "const b = 2;");
    await fs.writeFile(join(codebaseDir, "lib", "c.ts"), "const c = 3;");
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("initialization", () => {
    it("should create synchronizer with specified concurrency", () => {
      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir, 4);
      expect(sync.getConcurrency()).toBe(4);
    });

    it("should use EMBEDDING_CONCURRENCY env if not specified", () => {
      const originalEnv = process.env.EMBEDDING_CONCURRENCY;
      process.env.EMBEDDING_CONCURRENCY = "8";

      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir);
      expect(sync.getConcurrency()).toBe(8);

      process.env.EMBEDDING_CONCURRENCY = originalEnv;
    });

    it("should default to 4 if no concurrency specified", () => {
      const originalEnv = process.env.EMBEDDING_CONCURRENCY;
      delete process.env.EMBEDDING_CONCURRENCY;

      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir);
      expect(sync.getConcurrency()).toBe(4);

      process.env.EMBEDDING_CONCURRENCY = originalEnv;
    });
  });

  describe("initial snapshot", () => {
    it("should create initial snapshot with all files", async () => {
      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir, 4);

      const files = [
        join(codebaseDir, "src", "a.ts"),
        join(codebaseDir, "src", "b.ts"),
        join(codebaseDir, "lib", "c.ts"),
      ];

      await sync.updateSnapshot(files);
      expect(await sync.hasSnapshot()).toBe(true);
    });

    it("should report no changes for initial snapshot", async () => {
      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir, 4);

      const files = [
        join(codebaseDir, "src", "a.ts"),
        join(codebaseDir, "src", "b.ts"),
        join(codebaseDir, "lib", "c.ts"),
      ];

      await sync.updateSnapshot(files);

      // Initialize and detect changes (should be none)
      await sync.initialize();
      const changes = await sync.detectChanges(files);

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
    });
  });

  describe("change detection", () => {
    it("should detect added files", async () => {
      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir, 4);

      // Create initial snapshot
      const initialFiles = [
        join(codebaseDir, "src", "a.ts"),
        join(codebaseDir, "src", "b.ts"),
      ];
      await sync.updateSnapshot(initialFiles);

      // Add new file
      await fs.writeFile(join(codebaseDir, "src", "new.ts"), "const new = 1;");

      // Detect changes
      await sync.initialize();
      const currentFiles = [
        join(codebaseDir, "src", "a.ts"),
        join(codebaseDir, "src", "b.ts"),
        join(codebaseDir, "src", "new.ts"),
      ];
      const changes = await sync.detectChanges(currentFiles);

      expect(changes.added).toContain("src/new.ts");
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
    });

    it("should detect modified files", async () => {
      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir, 4);

      const files = [
        join(codebaseDir, "src", "a.ts"),
        join(codebaseDir, "src", "b.ts"),
      ];
      await sync.updateSnapshot(files);

      // Modify file (change content)
      await fs.writeFile(join(codebaseDir, "src", "a.ts"), "const a = 999; // modified");

      // Detect changes
      await sync.initialize();
      const changes = await sync.detectChanges(files);

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toContain("src/a.ts");
      expect(changes.deleted).toHaveLength(0);
    });

    it("should detect deleted files", async () => {
      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir, 4);

      const initialFiles = [
        join(codebaseDir, "src", "a.ts"),
        join(codebaseDir, "src", "b.ts"),
        join(codebaseDir, "lib", "c.ts"),
      ];
      await sync.updateSnapshot(initialFiles);

      // Delete file
      await fs.unlink(join(codebaseDir, "lib", "c.ts"));

      // Detect changes with reduced file list
      await sync.initialize();
      const currentFiles = [
        join(codebaseDir, "src", "a.ts"),
        join(codebaseDir, "src", "b.ts"),
      ];
      const changes = await sync.detectChanges(currentFiles);

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toContain("lib/c.ts");
    });

    it("should detect multiple changes at once", async () => {
      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir, 4);

      const initialFiles = [
        join(codebaseDir, "src", "a.ts"),
        join(codebaseDir, "src", "b.ts"),
        join(codebaseDir, "lib", "c.ts"),
      ];
      await sync.updateSnapshot(initialFiles);

      // Add new file
      await fs.writeFile(join(codebaseDir, "src", "new.ts"), "const new = 1;");
      // Modify existing file
      await fs.writeFile(join(codebaseDir, "src", "a.ts"), "const a = 999;");
      // Delete file
      await fs.unlink(join(codebaseDir, "lib", "c.ts"));

      await sync.initialize();
      const currentFiles = [
        join(codebaseDir, "src", "a.ts"),
        join(codebaseDir, "src", "b.ts"),
        join(codebaseDir, "src", "new.ts"),
      ];
      const changes = await sync.detectChanges(currentFiles);

      expect(changes.added).toContain("src/new.ts");
      expect(changes.modified).toContain("src/a.ts");
      expect(changes.deleted).toContain("lib/c.ts");
    });
  });

  describe("parallel processing", () => {
    it("should process files in parallel across shards", async () => {
      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir, 4);

      // Create many files
      for (let i = 0; i < 20; i++) {
        await fs.writeFile(join(codebaseDir, "src", `file-${i}.ts`), `const x${i} = ${i};`);
      }

      const files: string[] = [];
      for (let i = 0; i < 20; i++) {
        files.push(join(codebaseDir, "src", `file-${i}.ts`));
      }

      // Should complete without error
      await sync.updateSnapshot(files);

      await sync.initialize();
      const changes = await sync.detectChanges(files);

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
    });

    it("should handle empty file list", async () => {
      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir, 4);

      await sync.updateSnapshot([]);

      await sync.initialize();
      const changes = await sync.detectChanges([]);

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
    });
  });

  describe("mtime+size fast path", () => {
    it("should use cached hash when mtime and size unchanged", async () => {
      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir, 4);

      const files = [join(codebaseDir, "src", "a.ts")];
      await sync.updateSnapshot(files);

      // File untouched - should use fast path
      await sync.initialize();
      const changes = await sync.detectChanges(files);

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
    });

    it("should recompute hash when mtime changes but content same", async () => {
      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir, 4);

      const filePath = join(codebaseDir, "src", "a.ts");
      const files = [filePath];
      await sync.updateSnapshot(files);

      // Touch file (changes mtime but not content)
      const content = await fs.readFile(filePath, "utf-8");
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
      await fs.writeFile(filePath, content);

      await sync.initialize();
      const changes = await sync.detectChanges(files);

      // Content same, should not be marked as modified
      expect(changes.modified).toHaveLength(0);
    });
  });

  describe("quick check", () => {
    it("should quickly detect if any changes exist via meta root hash", async () => {
      const sync = new ParallelFileSynchronizer(codebaseDir, "test-collection", snapshotDir, 4);

      const files = [
        join(codebaseDir, "src", "a.ts"),
        join(codebaseDir, "src", "b.ts"),
      ];
      await sync.updateSnapshot(files);

      await sync.initialize();

      // No changes - quick check should return false
      expect(await sync.needsReindex(files)).toBe(false);

      // Modify file
      await fs.writeFile(join(codebaseDir, "src", "a.ts"), "modified content");

      // Changes exist - quick check should return true
      expect(await sync.needsReindex(files)).toBe(true);
    });
  });
});
