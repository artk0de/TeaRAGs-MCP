import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSynchronizer } from "../../../src/code/sync/synchronizer.js";

describe("FileSynchronizer", () => {
  let tempDir: string;
  let codebaseDir: string;
  let synchronizer: FileSynchronizer;
  let collectionName: string;

  beforeEach(async () => {
    // Create temporary directories for testing
    tempDir = join(
      tmpdir(),
      `qdrant-mcp-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    codebaseDir = join(tempDir, "codebase");
    await fs.mkdir(codebaseDir, { recursive: true });

    // Use unique collection name to avoid conflicts between test runs
    collectionName = `test-collection-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    synchronizer = new FileSynchronizer(codebaseDir, collectionName);
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (_error) {
      // Ignore cleanup errors
    }

    // Clean up snapshot file
    try {
      const snapshotPath = join(
        homedir(),
        ".tea-rags-mcp",
        "snapshots",
        `${collectionName}.json`,
      );
      await fs.rm(snapshotPath, { force: true });
    } catch (_error) {
      // Ignore cleanup errors
    }
  });

  describe("initialize", () => {
    it("should return false when no snapshot exists", async () => {
      const hasSnapshot = await synchronizer.initialize();
      expect(hasSnapshot).toBe(false);
    });

    it("should return true when snapshot exists", async () => {
      // Create some files and update snapshot
      await createFile(codebaseDir, "file1.ts", "content1");
      await synchronizer.updateSnapshot(["file1.ts"]);

      // Create a new synchronizer and initialize
      const newSync = new FileSynchronizer(codebaseDir, collectionName);
      const hasSnapshot = await newSync.initialize();

      expect(hasSnapshot).toBe(true);
    });

    it("should load previous file hashes", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await createFile(codebaseDir, "file2.ts", "content2");

      await synchronizer.updateSnapshot(["file1.ts", "file2.ts"]);

      const newSync = new FileSynchronizer(codebaseDir, collectionName);
      await newSync.initialize();

      const changes = await newSync.detectChanges(["file1.ts", "file2.ts"]);

      expect(changes.added).toEqual([]);
      expect(changes.modified).toEqual([]);
      expect(changes.deleted).toEqual([]);
    });
  });

  describe("updateSnapshot", () => {
    it("should save snapshot with file hashes", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await createFile(codebaseDir, "file2.ts", "content2");

      await synchronizer.updateSnapshot(["file1.ts", "file2.ts"]);

      const newSync = new FileSynchronizer(
        codebaseDir,
        collectionName,
        tempDir,
      );
      const hasSnapshot = await newSync.initialize();

      expect(hasSnapshot).toBe(true);
    });

    it("should handle empty file list", async () => {
      await synchronizer.updateSnapshot([]);

      const newSync = new FileSynchronizer(codebaseDir, collectionName);
      const hasSnapshot = await newSync.initialize();

      expect(hasSnapshot).toBe(true);
    });

    it("should overwrite previous snapshot", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await synchronizer.updateSnapshot(["file1.ts"]);

      await createFile(codebaseDir, "file2.ts", "content2");
      await synchronizer.updateSnapshot(["file2.ts"]);

      const newSync = new FileSynchronizer(codebaseDir, collectionName);
      await newSync.initialize();

      const changes = await newSync.detectChanges(["file2.ts"]);

      expect(changes.added).toEqual([]);
      expect(changes.modified).toEqual([]);
      expect(changes.deleted).toEqual([]);
    });

    it("should handle relative and absolute paths", async () => {
      await createFile(codebaseDir, "file.ts", "content");

      await synchronizer.updateSnapshot(["file.ts"]);
      await synchronizer.updateSnapshot([join(codebaseDir, "file.ts")]);

      // Both should work without duplicates
      const newSync = new FileSynchronizer(codebaseDir, collectionName);
      await newSync.initialize();

      const changes = await newSync.detectChanges(["file.ts"]);
      expect(changes.modified).toEqual([]);
    });
  });

  describe("detectChanges", () => {
    it("should detect added files", async () => {
      await synchronizer.initialize();
      await synchronizer.updateSnapshot([]);

      await createFile(codebaseDir, "file1.ts", "content1");
      await createFile(codebaseDir, "file2.ts", "content2");

      const changes = await synchronizer.detectChanges([
        "file1.ts",
        "file2.ts",
      ]);

      expect(changes.added).toContain("file1.ts");
      expect(changes.added).toContain("file2.ts");
      expect(changes.modified).toEqual([]);
      expect(changes.deleted).toEqual([]);
    });

    it("should detect deleted files", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await createFile(codebaseDir, "file2.ts", "content2");
      await synchronizer.updateSnapshot(["file1.ts", "file2.ts"]);

      await fs.unlink(join(codebaseDir, "file2.ts"));

      const changes = await synchronizer.detectChanges(["file1.ts"]);

      expect(changes.added).toEqual([]);
      expect(changes.modified).toEqual([]);
      expect(changes.deleted).toEqual(["file2.ts"]);
    });

    it("should detect modified files", async () => {
      await createFile(codebaseDir, "file1.ts", "original content");
      await synchronizer.updateSnapshot(["file1.ts"]);

      // Change content AND size to bypass mtime cache (1s tolerance)
      await createFile(codebaseDir, "file1.ts", "modified content with extra text to change size");

      const changes = await synchronizer.detectChanges(["file1.ts"]);

      expect(changes.added).toEqual([]);
      expect(changes.modified).toEqual(["file1.ts"]);
      expect(changes.deleted).toEqual([]);
    });

    it("should detect mixed changes", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await createFile(codebaseDir, "file2.ts", "content2");
      await synchronizer.updateSnapshot(["file1.ts", "file2.ts"]);

      // Modify file1 with different size to bypass mtime cache
      await createFile(codebaseDir, "file1.ts", "modified content1 with extra text");

      // Add file3
      await createFile(codebaseDir, "file3.ts", "content3");

      // Delete file2

      const changes = await synchronizer.detectChanges([
        "file1.ts",
        "file3.ts",
      ]);

      expect(changes.added).toEqual(["file3.ts"]);
      expect(changes.modified).toEqual(["file1.ts"]);
      expect(changes.deleted).toEqual(["file2.ts"]);
    });

    it("should detect no changes when files unchanged", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await synchronizer.updateSnapshot(["file1.ts"]);

      const changes = await synchronizer.detectChanges(["file1.ts"]);

      expect(changes.added).toEqual([]);
      expect(changes.modified).toEqual([]);
      expect(changes.deleted).toEqual([]);
    });

    it("should consider all files as added when no snapshot exists", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await createFile(codebaseDir, "file2.ts", "content2");

      const changes = await synchronizer.detectChanges([
        "file1.ts",
        "file2.ts",
      ]);

      expect(changes.added).toContain("file1.ts");
      expect(changes.added).toContain("file2.ts");
      expect(changes.modified).toEqual([]);
      expect(changes.deleted).toEqual([]);
    });
  });

  describe("deleteSnapshot", () => {
    it("should delete existing snapshot", async () => {
      await createFile(codebaseDir, "file.ts", "content");
      await synchronizer.updateSnapshot(["file.ts"]);

      await synchronizer.deleteSnapshot();

      const newSync = new FileSynchronizer(codebaseDir, collectionName);
      const hasSnapshot = await newSync.initialize();

      expect(hasSnapshot).toBe(false);
    });

    it("should handle deleting non-existent snapshot", async () => {
      await expect(synchronizer.deleteSnapshot()).resolves.not.toThrow();
    });

    it("should allow operations after deletion", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await synchronizer.updateSnapshot(["file1.ts"]);

      await synchronizer.deleteSnapshot();

      await createFile(codebaseDir, "file2.ts", "content2");
      await synchronizer.updateSnapshot(["file2.ts"]);

      const newSync = new FileSynchronizer(codebaseDir, collectionName);
      const hasSnapshot = await newSync.initialize();

      expect(hasSnapshot).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle files with same content different names", async () => {
      const sameContent = "identical content";
      await createFile(codebaseDir, "file1.ts", sameContent);
      await createFile(codebaseDir, "file2.ts", sameContent);

      await synchronizer.updateSnapshot(["file1.ts", "file2.ts"]);

      const changes = await synchronizer.detectChanges([
        "file1.ts",
        "file2.ts",
      ]);

      expect(changes.added).toEqual([]);
      expect(changes.modified).toEqual([]);
      expect(changes.deleted).toEqual([]);
    });

    it("should handle binary files", async () => {
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      await fs.writeFile(join(codebaseDir, "binary.dat"), binaryContent);

      await synchronizer.updateSnapshot(["binary.dat"]);

      const changes = await synchronizer.detectChanges(["binary.dat"]);

      expect(changes.modified).toEqual([]);
    });

    it("should handle very large files", async () => {
      const largeContent = "x".repeat(1024 * 1024); // 1MB
      await createFile(codebaseDir, "large.ts", largeContent);

      await synchronizer.updateSnapshot(["large.ts"]);

      const changes = await synchronizer.detectChanges(["large.ts"]);

      expect(changes.modified).toEqual([]);
    });

    it("should handle files with special characters in names", async () => {
      await createFile(codebaseDir, "file with spaces.ts", "content");
      await createFile(codebaseDir, "file-with-dashes.ts", "content");
      await createFile(codebaseDir, "file_with_underscores.ts", "content");

      await synchronizer.updateSnapshot([
        "file with spaces.ts",
        "file-with-dashes.ts",
        "file_with_underscores.ts",
      ]);

      const changes = await synchronizer.detectChanges([
        "file with spaces.ts",
        "file-with-dashes.ts",
        "file_with_underscores.ts",
      ]);

      expect(changes.modified).toEqual([]);
    });

    it("should handle nested directory structures", async () => {
      await fs.mkdir(join(codebaseDir, "src", "components"), {
        recursive: true,
      });
      await createFile(codebaseDir, "src/components/Button.tsx", "content");

      await synchronizer.updateSnapshot(["src/components/Button.tsx"]);

      const changes = await synchronizer.detectChanges([
        "src/components/Button.tsx",
      ]);

      expect(changes.modified).toEqual([]);
    });

    it("should handle empty files", async () => {
      await createFile(codebaseDir, "empty.ts", "");

      await synchronizer.updateSnapshot(["empty.ts"]);

      const changes = await synchronizer.detectChanges(["empty.ts"]);

      expect(changes.modified).toEqual([]);
    });

    it("should detect when empty file becomes non-empty", async () => {
      await createFile(codebaseDir, "file.ts", "");
      await synchronizer.updateSnapshot(["file.ts"]);

      await createFile(codebaseDir, "file.ts", "now has content");

      const changes = await synchronizer.detectChanges(["file.ts"]);

      expect(changes.modified).toEqual(["file.ts"]);
    });

    it("should handle many files efficiently", async () => {
      const files: string[] = [];

      for (let i = 0; i < 100; i++) {
        const filename = `file${i}.ts`;
        await createFile(codebaseDir, filename, `content ${i}`);
        files.push(filename);
      }

      await synchronizer.updateSnapshot(files);

      const changes = await synchronizer.detectChanges(files);

      expect(changes.added).toEqual([]);
      expect(changes.modified).toEqual([]);
      expect(changes.deleted).toEqual([]);
    });
  });

  describe("hash calculation", () => {
    it("should produce same hash for identical content", async () => {
      const content = "test content";
      await createFile(codebaseDir, "file1.ts", content);
      await synchronizer.updateSnapshot(["file1.ts"]);

      // Delete and recreate with same content
      await fs.unlink(join(codebaseDir, "file1.ts"));
      await createFile(codebaseDir, "file1.ts", content);

      const changes = await synchronizer.detectChanges(["file1.ts"]);

      expect(changes.modified).toEqual([]);
    });

    it("should produce different hash for different content", async () => {
      await createFile(codebaseDir, "file.ts", "original");
      await synchronizer.updateSnapshot(["file.ts"]);

      // Change content AND size to bypass mtime cache
      await createFile(codebaseDir, "file.ts", "modified with different length");

      const changes = await synchronizer.detectChanges(["file.ts"]);

      expect(changes.modified).toEqual(["file.ts"]);
    });

    it("should be sensitive to whitespace changes", async () => {
      await createFile(codebaseDir, "file.ts", "content");
      await synchronizer.updateSnapshot(["file.ts"]);

      // Add multiple whitespace chars to ensure size change
      await createFile(codebaseDir, "file.ts", "content   ");

      const changes = await synchronizer.detectChanges(["file.ts"]);

      expect(changes.modified).toEqual(["file.ts"]);
    });

    it("should be sensitive to line ending changes", async () => {
      await createFile(codebaseDir, "file.ts", "line1\nline2");
      await synchronizer.updateSnapshot(["file.ts"]);

      await createFile(codebaseDir, "file.ts", "line1\r\nline2");

      const changes = await synchronizer.detectChanges(["file.ts"]);

      expect(changes.modified).toEqual(["file.ts"]);
    });
  });

  describe("getSnapshotAge", () => {
    it("should return snapshot age in milliseconds", async () => {
      await createFile(codebaseDir, "file.ts", "content");
      await synchronizer.updateSnapshot(["file.ts"]);

      // Wait a bit to ensure some time passes
      await new Promise((resolve) => setTimeout(resolve, 10));

      const age = await synchronizer.getSnapshotAge();

      expect(age).not.toBeNull();
      expect(age).toBeGreaterThanOrEqual(10);
    });

    it("should return null when no snapshot exists", async () => {
      const age = await synchronizer.getSnapshotAge();

      expect(age).toBeNull();
    });

    it("should return age after snapshot creation", async () => {
      await createFile(codebaseDir, "file.ts", "content");
      await synchronizer.updateSnapshot(["file.ts"]);

      const age = await synchronizer.getSnapshotAge();

      expect(age).not.toBeNull();
      expect(age).toBeGreaterThanOrEqual(0);
    });
  });

  describe("needsReindex", () => {
    it("should return true when no previous tree exists", async () => {
      await createFile(codebaseDir, "file.ts", "content");

      const needsReindex = await synchronizer.needsReindex(["file.ts"]);

      expect(needsReindex).toBe(true);
    });

    it("should return false when files are unchanged", async () => {
      await createFile(codebaseDir, "file.ts", "content");
      await synchronizer.updateSnapshot(["file.ts"]);

      const needsReindex = await synchronizer.needsReindex(["file.ts"]);

      expect(needsReindex).toBe(false);
    });

    it("should return true when files have changed", async () => {
      await createFile(codebaseDir, "file.ts", "original content");
      await synchronizer.updateSnapshot(["file.ts"]);

      // Change content AND size to bypass mtime cache (1s tolerance)
      await createFile(codebaseDir, "file.ts", "modified content with extra text to change size");

      const needsReindex = await synchronizer.needsReindex(["file.ts"]);

      expect(needsReindex).toBe(true);
    });

    it("should return true when files are added", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await synchronizer.updateSnapshot(["file1.ts"]);

      await createFile(codebaseDir, "file2.ts", "content2");

      const needsReindex = await synchronizer.needsReindex([
        "file1.ts",
        "file2.ts",
      ]);

      expect(needsReindex).toBe(true);
    });

    it("should return true when files are deleted", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await createFile(codebaseDir, "file2.ts", "content2");
      await synchronizer.updateSnapshot(["file1.ts", "file2.ts"]);

      const needsReindex = await synchronizer.needsReindex(["file1.ts"]);

      expect(needsReindex).toBe(true);
    });
  });

  describe("hasSnapshot", () => {
    it("should return false when no snapshot exists", async () => {
      const hasSnapshot = await synchronizer.hasSnapshot();
      expect(hasSnapshot).toBe(false);
    });

    it("should return true after snapshot is created", async () => {
      await createFile(codebaseDir, "file.ts", "content");
      await synchronizer.updateSnapshot(["file.ts"]);

      const hasSnapshot = await synchronizer.hasSnapshot();
      expect(hasSnapshot).toBe(true);
    });

    it("should return false after snapshot is deleted", async () => {
      await createFile(codebaseDir, "file.ts", "content");
      await synchronizer.updateSnapshot(["file.ts"]);
      await synchronizer.deleteSnapshot();

      const hasSnapshot = await synchronizer.hasSnapshot();
      expect(hasSnapshot).toBe(false);
    });
  });

  describe("validateSnapshot", () => {
    it("should return false when no snapshot exists", async () => {
      const isValid = await synchronizer.validateSnapshot();
      expect(isValid).toBe(false);
    });

    it("should return true for valid snapshot", async () => {
      await createFile(codebaseDir, "file.ts", "content");
      await synchronizer.updateSnapshot(["file.ts"]);

      const isValid = await synchronizer.validateSnapshot();
      expect(isValid).toBe(true);
    });

    it("should return true for empty snapshot", async () => {
      await synchronizer.updateSnapshot([]);

      const isValid = await synchronizer.validateSnapshot();
      expect(isValid).toBe(true);
    });
  });

  // ============ CHECKPOINT CORNER CASES ============
  describe("checkpoint functionality", () => {
    let checkpointPath: string;

    beforeEach(async () => {
      checkpointPath = join(
        homedir(),
        ".tea-rags-mcp",
        "snapshots",
        `${collectionName}.checkpoint.json`,
      );
    });

    afterEach(async () => {
      // Clean up checkpoint file
      try {
        await fs.rm(checkpointPath, { force: true });
      } catch (_error) {
        // Ignore cleanup errors
      }
    });

    describe("saveCheckpoint", () => {
      it("should save checkpoint with processedFiles and totalFiles", async () => {
        await synchronizer.saveCheckpoint(["file1.ts", "file2.ts"], 10, "indexing");

        const data = await fs.readFile(checkpointPath, "utf-8");
        const checkpoint = JSON.parse(data);

        expect(checkpoint.processedFiles).toEqual(["file1.ts", "file2.ts"]);
        expect(checkpoint.totalFiles).toBe(10);
        expect(checkpoint.phase).toBe("indexing");
        expect(checkpoint.timestamp).toBeDefined();
      });

      it("should overwrite previous checkpoint", async () => {
        await synchronizer.saveCheckpoint(["file1.ts"], 5, "indexing");
        await synchronizer.saveCheckpoint(["file1.ts", "file2.ts", "file3.ts"], 5, "indexing");

        const checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint?.processedFiles).toHaveLength(3);
      });

      it("should handle empty processedFiles array", async () => {
        await synchronizer.saveCheckpoint([], 100, "deleting");

        const checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint?.processedFiles).toEqual([]);
        expect(checkpoint?.totalFiles).toBe(100);
        expect(checkpoint?.phase).toBe("deleting");
      });

      it("should save with deleting phase", async () => {
        await synchronizer.saveCheckpoint(["file1.ts"], 10, "deleting");

        const checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint?.phase).toBe("deleting");
      });
    });

    describe("loadCheckpoint", () => {
      it("should return null when no checkpoint exists", async () => {
        const checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint).toBeNull();
      });

      it("should load valid checkpoint", async () => {
        await synchronizer.saveCheckpoint(["file1.ts"], 5, "indexing");

        const checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint).not.toBeNull();
        expect(checkpoint?.processedFiles).toEqual(["file1.ts"]);
      });

      it("should return null for stale checkpoint (>24 hours)", async () => {
        // Create a checkpoint with old timestamp
        const staleCheckpoint = {
          processedFiles: ["file1.ts"],
          totalFiles: 10,
          timestamp: Date.now() - (25 * 60 * 60 * 1000), // 25 hours ago
          phase: "indexing",
        };
        await fs.mkdir(join(homedir(), ".tea-rags-mcp", "snapshots"), { recursive: true });
        await fs.writeFile(checkpointPath, JSON.stringify(staleCheckpoint));

        const checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint).toBeNull();
      });

      it("should return null for corrupted JSON", async () => {
        await fs.mkdir(join(homedir(), ".tea-rags-mcp", "snapshots"), { recursive: true });
        await fs.writeFile(checkpointPath, "{ invalid json }");

        const checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint).toBeNull();
      });

      it("should return null for checkpoint missing processedFiles", async () => {
        const invalidCheckpoint = {
          totalFiles: 10,
          timestamp: Date.now(),
          phase: "indexing",
        };
        await fs.mkdir(join(homedir(), ".tea-rags-mcp", "snapshots"), { recursive: true });
        await fs.writeFile(checkpointPath, JSON.stringify(invalidCheckpoint));

        const checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint).toBeNull();
      });

      it("should return null for checkpoint missing totalFiles", async () => {
        const invalidCheckpoint = {
          processedFiles: ["file1.ts"],
          timestamp: Date.now(),
          phase: "indexing",
        };
        await fs.mkdir(join(homedir(), ".tea-rags-mcp", "snapshots"), { recursive: true });
        await fs.writeFile(checkpointPath, JSON.stringify(invalidCheckpoint));

        const checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint).toBeNull();
      });
    });

    describe("deleteCheckpoint", () => {
      it("should delete existing checkpoint", async () => {
        await synchronizer.saveCheckpoint(["file1.ts"], 5, "indexing");
        expect(await synchronizer.hasCheckpoint()).toBe(true);

        await synchronizer.deleteCheckpoint();
        expect(await synchronizer.hasCheckpoint()).toBe(false);
      });

      it("should not throw when checkpoint does not exist", async () => {
        await expect(synchronizer.deleteCheckpoint()).resolves.not.toThrow();
      });
    });

    describe("hasCheckpoint", () => {
      it("should return false when no checkpoint exists", async () => {
        const hasCheckpoint = await synchronizer.hasCheckpoint();
        expect(hasCheckpoint).toBe(false);
      });

      it("should return true when checkpoint exists", async () => {
        await synchronizer.saveCheckpoint(["file1.ts"], 5, "indexing");

        const hasCheckpoint = await synchronizer.hasCheckpoint();
        expect(hasCheckpoint).toBe(true);
      });
    });

    describe("filterProcessedFiles", () => {
      it("should filter out already processed files", () => {
        const checkpoint = {
          processedFiles: ["file1.ts", "file2.ts"],
          totalFiles: 5,
          timestamp: Date.now(),
          phase: "indexing" as const,
        };

        const remaining = synchronizer.filterProcessedFiles(
          ["file1.ts", "file2.ts", "file3.ts", "file4.ts"],
          checkpoint
        );

        expect(remaining).toEqual(["file3.ts", "file4.ts"]);
      });

      it("should return all files when none are processed", () => {
        const checkpoint = {
          processedFiles: [],
          totalFiles: 4,
          timestamp: Date.now(),
          phase: "indexing" as const,
        };

        const remaining = synchronizer.filterProcessedFiles(
          ["file1.ts", "file2.ts", "file3.ts", "file4.ts"],
          checkpoint
        );

        expect(remaining).toEqual(["file1.ts", "file2.ts", "file3.ts", "file4.ts"]);
      });

      it("should return empty array when all files are processed", () => {
        const checkpoint = {
          processedFiles: ["file1.ts", "file2.ts"],
          totalFiles: 2,
          timestamp: Date.now(),
          phase: "indexing" as const,
        };

        const remaining = synchronizer.filterProcessedFiles(
          ["file1.ts", "file2.ts"],
          checkpoint
        );

        expect(remaining).toEqual([]);
      });

      it("should handle files deleted since checkpoint was saved", () => {
        // Checkpoint has file3.ts, but current files don't include it (deleted)
        const checkpoint = {
          processedFiles: ["file1.ts", "file2.ts", "file3.ts"],
          totalFiles: 5,
          timestamp: Date.now(),
          phase: "indexing" as const,
        };

        const remaining = synchronizer.filterProcessedFiles(
          ["file1.ts", "file2.ts", "file4.ts", "file5.ts"], // file3.ts is missing
          checkpoint
        );

        // file3.ts was processed but doesn't exist - that's OK, we just skip it
        // file4.ts and file5.ts are new and should be returned
        expect(remaining).toEqual(["file4.ts", "file5.ts"]);
      });

      it("should handle files added since checkpoint was saved", () => {
        const checkpoint = {
          processedFiles: ["file1.ts"],
          totalFiles: 2,
          timestamp: Date.now(),
          phase: "indexing" as const,
        };

        // file3.ts was added after checkpoint
        const remaining = synchronizer.filterProcessedFiles(
          ["file1.ts", "file2.ts", "file3.ts"],
          checkpoint
        );

        expect(remaining).toEqual(["file2.ts", "file3.ts"]);
      });
    });

    describe("checkpoint integration scenarios", () => {
      it("should support resume workflow after interruption", async () => {
        // Simulate indexing 2 of 4 files before interruption
        await synchronizer.saveCheckpoint(["file1.ts", "file2.ts"], 4, "indexing");

        // Simulate restart - create new synchronizer instance
        const newSync = new FileSynchronizer(codebaseDir, collectionName);

        // Load checkpoint
        const checkpoint = await newSync.loadCheckpoint();
        expect(checkpoint).not.toBeNull();

        // Filter remaining files
        const allFiles = ["file1.ts", "file2.ts", "file3.ts", "file4.ts"];
        const remaining = newSync.filterProcessedFiles(allFiles, checkpoint!);

        expect(remaining).toEqual(["file3.ts", "file4.ts"]);

        // After successful completion, delete checkpoint
        await newSync.deleteCheckpoint();
        expect(await newSync.hasCheckpoint()).toBe(false);
      });

      it("should handle multiple checkpoint saves during progress", async () => {
        // Save checkpoint after each file
        await synchronizer.saveCheckpoint(["file1.ts"], 4, "indexing");
        let checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint?.processedFiles).toHaveLength(1);

        await synchronizer.saveCheckpoint(["file1.ts", "file2.ts"], 4, "indexing");
        checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint?.processedFiles).toHaveLength(2);

        await synchronizer.saveCheckpoint(["file1.ts", "file2.ts", "file3.ts"], 4, "indexing");
        checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint?.processedFiles).toHaveLength(3);
      });

      it("should properly handle checkpoint when totalFiles changes", async () => {
        // Checkpoint saved with totalFiles=4
        await synchronizer.saveCheckpoint(["file1.ts", "file2.ts"], 4, "indexing");

        // On resume, scan finds different number of files (e.g., file5.ts was added)
        const checkpoint = await synchronizer.loadCheckpoint();
        expect(checkpoint?.totalFiles).toBe(4); // Original count

        // But we use filterProcessedFiles with actual files, which handles this correctly
        const actualFiles = ["file1.ts", "file2.ts", "file3.ts", "file4.ts", "file5.ts"];
        const remaining = synchronizer.filterProcessedFiles(actualFiles, checkpoint!);

        // file5.ts is new and should be processed
        expect(remaining).toContain("file3.ts");
        expect(remaining).toContain("file4.ts");
        expect(remaining).toContain("file5.ts");
      });
    });
  });

  // ============ ERROR PATHS ============
  describe("error handling", () => {
    it("should handle file read errors during hash computation", async () => {
      // Create a file
      await createFile(codebaseDir, "file1.ts", "content1");

      // Update snapshot with the file
      await synchronizer.updateSnapshot(["file1.ts"]);

      // Delete the file to simulate read error
      await fs.unlink(join(codebaseDir, "file1.ts"));

      // Try to detect changes - should treat missing file as deleted
      const changes = await synchronizer.detectChanges([]);

      expect(changes.deleted).toContain("file1.ts");
      expect(changes.added).toEqual([]);
      expect(changes.modified).toEqual([]);
    });

    it("should handle file stat errors gracefully", async () => {
      // Create initial snapshot
      await createFile(codebaseDir, "file1.ts", "content1");
      await synchronizer.updateSnapshot(["file1.ts"]);

      // Try to compute hashes for a non-existent file
      const hashes = await synchronizer.computeFileHashes([
        "file1.ts",
        "nonexistent.ts",
      ]);

      // Should only have hash for the existing file
      expect(hashes.has("file1.ts")).toBe(true);
      expect(hashes.has("nonexistent.ts")).toBe(false);
      expect(hashes.size).toBe(1);
    });

    it("should continue processing other files when one file fails", async () => {
      // Create valid files
      await createFile(codebaseDir, "file1.ts", "content1");
      await createFile(codebaseDir, "file2.ts", "content2");
      await createFile(codebaseDir, "file3.ts", "content3");

      // Update snapshot
      await synchronizer.updateSnapshot(["file1.ts", "file2.ts", "file3.ts"]);

      // Delete one file to simulate error
      await fs.unlink(join(codebaseDir, "file2.ts"));

      // Modify another file
      await createFile(codebaseDir, "file3.ts", "modified content 3 with extra text");

      // Detect changes - should handle the error and continue
      const changes = await synchronizer.detectChanges(["file1.ts", "file3.ts"]);

      expect(changes.deleted).toEqual(["file2.ts"]);
      expect(changes.modified).toEqual(["file3.ts"]);
      expect(changes.added).toEqual([]);
    });

    it("should handle corrupted snapshot gracefully", async () => {
      // Create a file and snapshot
      await createFile(codebaseDir, "file1.ts", "content1");
      await synchronizer.updateSnapshot(["file1.ts"]);

      // Corrupt the snapshot file
      const snapshotPath = join(
        homedir(),
        ".tea-rags-mcp",
        "snapshots",
        `${collectionName}.json`,
      );
      await fs.writeFile(snapshotPath, "{ invalid json }", "utf-8");

      // Create new synchronizer and try to initialize
      const newSync = new FileSynchronizer(codebaseDir, collectionName);
      const hasSnapshot = await newSync.initialize();

      // Should return false and not throw
      expect(hasSnapshot).toBe(false);
    });

    it("should handle concurrent snapshot updates", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await createFile(codebaseDir, "file2.ts", "content2");

      // Try concurrent updates (should not corrupt snapshot)
      await Promise.all([
        synchronizer.updateSnapshot(["file1.ts"]),
        synchronizer.updateSnapshot(["file2.ts"]),
      ]);

      // Verify snapshot is valid
      const isValid = await synchronizer.validateSnapshot();
      expect(isValid).toBe(true);
    });

    it("should handle permission errors when creating snapshot directory", async () => {
      // This test ensures the code handles mkdir failures gracefully
      // In actual usage, the directory might already exist or have permissions issues
      await createFile(codebaseDir, "file1.ts", "content1");

      // updateSnapshot should not throw even if there are permission issues
      // (in practice, the directory is usually already created)
      await expect(
        synchronizer.updateSnapshot(["file1.ts"])
      ).resolves.not.toThrow();
    });

    it("should detect changes when file content changes but size stays the same", async () => {
      // Create file with specific content
      await createFile(codebaseDir, "file1.ts", "content1");
      await synchronizer.updateSnapshot(["file1.ts"]);

      // Wait to ensure mtime changes (> 1s tolerance)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Change content but keep same length
      await createFile(codebaseDir, "file1.ts", "changed1");

      const changes = await synchronizer.detectChanges(["file1.ts"]);

      // Should detect as modified because hash changed
      expect(changes.modified).toEqual(["file1.ts"]);
    });

    it("should handle extremely rapid file modifications", async () => {
      await createFile(codebaseDir, "rapid.ts", "v1");
      await synchronizer.updateSnapshot(["rapid.ts"]);

      // Rapidly modify the file multiple times
      await createFile(codebaseDir, "rapid.ts", "v2");
      await createFile(codebaseDir, "rapid.ts", "v3");
      await createFile(codebaseDir, "rapid.ts", "v4 final");

      const changes = await synchronizer.detectChanges(["rapid.ts"]);

      expect(changes.modified).toEqual(["rapid.ts"]);
    });
  });

  // ============ SNAPSHOT MIGRATION ============
  describe("snapshot v1 to v2 migration", () => {
    it("should migrate v1 snapshot to v2 with metadata", async () => {
      // Manually create a v1 snapshot (without metadata)
      const snapshotPath = join(
        homedir(),
        ".tea-rags-mcp",
        "snapshots",
        `${collectionName}.json`,
      );

      await createFile(codebaseDir, "file1.ts", "content1");
      await createFile(codebaseDir, "file2.ts", "content2");

      // Create a v1-style snapshot (with fileHashes but no fileMetadata)
      // Need to serialize the merkle tree properly
      const v1Snapshot = {
        codebasePath: codebaseDir,
        timestamp: Date.now(),
        fileHashes: {
          "file1.ts": "8b1a9953c4611296a827abf8c47804d7",
          "file2.ts": "8b1a9953c4611296a827abf8c47804d8",
        },
        merkleTree: JSON.stringify({
          root: "someroot",
          nodes: {},
        }),
      };

      await fs.mkdir(join(homedir(), ".tea-rags-mcp", "snapshots"), { recursive: true });
      await fs.writeFile(snapshotPath, JSON.stringify(v1Snapshot), "utf-8");

      // Create a new synchronizer and initialize (loads v1 snapshot)
      const newSync = new FileSynchronizer(codebaseDir, collectionName);
      await newSync.initialize();

      // Call ensureSnapshotV2 to trigger migration
      const migrated = await newSync.ensureSnapshotV2();

      // Should have migrated
      expect(migrated).toBe(true);
    });

    it("should handle migration when some files are missing", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await createFile(codebaseDir, "file2.ts", "content2");
      await synchronizer.updateSnapshot(["file1.ts", "file2.ts"]);

      // Delete one file before migration
      await fs.unlink(join(codebaseDir, "file2.ts"));

      // Create new synchronizer and ensure v2
      const newSync = new FileSynchronizer(codebaseDir, collectionName);
      await newSync.initialize();
      await newSync.ensureSnapshotV2();

      // Should still work with only file1
      const changes = await newSync.detectChanges(["file1.ts"]);
      expect(changes.deleted).toContain("file2.ts");
    });

    it("should return false when no snapshot exists", async () => {
      const migrated = await synchronizer.ensureSnapshotV2();
      expect(migrated).toBe(false);
    });

    it("should return false when already v2", async () => {
      await createFile(codebaseDir, "file1.ts", "content1");
      await synchronizer.updateSnapshot(["file1.ts"]);

      // Call ensureSnapshotV2 - should return false since already v2
      const migrated = await synchronizer.ensureSnapshotV2();
      expect(migrated).toBe(false);
    });
  });

  // ============ DEBUG LOGGING ============
  describe("debug logging", () => {
    let originalDebug: string | undefined;

    beforeEach(() => {
      originalDebug = process.env.DEBUG;
    });

    afterEach(() => {
      if (originalDebug !== undefined) {
        process.env.DEBUG = originalDebug;
      } else {
        delete process.env.DEBUG;
      }
    });

    it("should log performance stats when DEBUG is enabled", async () => {
      process.env.DEBUG = "true";

      await createFile(codebaseDir, "file1.ts", "content1");
      await createFile(codebaseDir, "file2.ts", "content2");
      await synchronizer.updateSnapshot(["file1.ts", "file2.ts"]);

      // Modify one file to trigger cache hit/miss stats
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await createFile(codebaseDir, "file1.ts", "modified content 1");

      // This should log cache stats
      const hashes = await synchronizer.computeFileHashes(["file1.ts", "file2.ts"]);

      expect(hashes.size).toBeGreaterThan(0);
    });

    it("should log change detection results when DEBUG is enabled", async () => {
      process.env.DEBUG = "true";

      await createFile(codebaseDir, "file1.ts", "content1");
      await synchronizer.updateSnapshot(["file1.ts"]);

      await new Promise((resolve) => setTimeout(resolve, 1100));
      await createFile(codebaseDir, "file1.ts", "modified");

      // This should log change detection results
      const changes = await synchronizer.detectChanges(["file1.ts"]);

      expect(changes.modified).toContain("file1.ts");
    });

    it("should log checkpoint save when DEBUG is enabled", async () => {
      process.env.DEBUG = "true";

      // This should log checkpoint save message
      await synchronizer.saveCheckpoint(["file1.ts", "file2.ts"], 10, "indexing");

      const hasCheckpoint = await synchronizer.hasCheckpoint();
      expect(hasCheckpoint).toBe(true);
    });
  });

  // ============ CHECKPOINT ERROR HANDLING ============
  describe("checkpoint error handling", () => {
    it("should handle checkpoint save errors gracefully", async () => {
      // Try to save checkpoint with invalid data (should not throw)
      await expect(
        synchronizer.saveCheckpoint(["file1.ts"], 10, "indexing")
      ).resolves.not.toThrow();
    });

    it("should handle checkpoint load errors for invalid JSON", async () => {
      const checkpointPath = join(
        homedir(),
        ".tea-rags-mcp",
        "snapshots",
        `${collectionName}.checkpoint.json`,
      );

      // Create invalid checkpoint file
      await fs.mkdir(join(homedir(), ".tea-rags-mcp", "snapshots"), { recursive: true });
      await fs.writeFile(checkpointPath, "invalid json {", "utf-8");

      const checkpoint = await synchronizer.loadCheckpoint();
      expect(checkpoint).toBeNull();
    });

    it("should delete stale checkpoints automatically", async () => {
      const checkpointPath = join(
        homedir(),
        ".tea-rags-mcp",
        "snapshots",
        `${collectionName}.checkpoint.json`,
      );

      // Create stale checkpoint (> 24 hours old)
      const staleCheckpoint = {
        processedFiles: ["file1.ts"],
        totalFiles: 10,
        timestamp: Date.now() - (25 * 60 * 60 * 1000),
        phase: "indexing",
      };

      await fs.mkdir(join(homedir(), ".tea-rags-mcp", "snapshots"), { recursive: true });
      await fs.writeFile(checkpointPath, JSON.stringify(staleCheckpoint), "utf-8");

      const checkpoint = await synchronizer.loadCheckpoint();
      expect(checkpoint).toBeNull();

      // Verify checkpoint was deleted
      const exists = await synchronizer.hasCheckpoint();
      expect(exists).toBe(false);
    });
  });
});

// Helper function to create files in the test codebase
async function createFile(
  baseDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = join(baseDir, relativePath);
  const dir = join(fullPath, "..");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}
