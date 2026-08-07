import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupTempDir,
  createTempTestDir,
  createTestFile,
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../__helpers__/test-helpers.js";
import { IngestFacade } from "../../../../../src/core/api/index.js";
import { PartialDeletionError } from "../../../../../src/core/domains/ingest/errors.js";
import { EnrichmentCoordinator } from "../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { ParallelFileSynchronizer } from "../../../../../src/core/domains/ingest/sync/parallel-synchronizer.js";
import { Migrator } from "../../../../../src/core/domains/maintenance/migration/migrator.js";
import type { IngestCodeConfig } from "../../../../../src/core/types.js";

vi.mock("tree-sitter", () => ({
  default: class MockParser {
    setLanguage() {}
    parse() {
      return {
        rootNode: {
          type: "program",
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: 0 },
          children: [],
          text: "",
          namedChildren: [],
        },
      };
    }
  },
}));
vi.mock("tree-sitter-bash", () => ({ default: {} }));
vi.mock("tree-sitter-go", () => ({ default: {} }));
vi.mock("tree-sitter-java", () => ({ default: {} }));
vi.mock("tree-sitter-javascript", () => ({ default: {} }));
vi.mock("tree-sitter-python", () => ({ default: {} }));
vi.mock("tree-sitter-rust", () => ({ default: {} }));
vi.mock("tree-sitter-typescript", () => ({
  default: { typescript: {}, tsx: {} },
}));

describe("ReindexPipeline", () => {
  let ingest: IngestFacade;
  let qdrant: MockQdrantManager;
  let embeddings: MockEmbeddingProvider;
  let config: IngestCodeConfig;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager() as any;
    embeddings = new MockEmbeddingProvider();
    config = defaultTestConfig();
    ingest = new IngestFacade({
      qdrant: qdrant as any,
      embeddings,
      config,
      trajectoryConfig: defaultTrajectoryConfig(),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("reindexChanges", () => {
    it("should throw error if not previously indexed", async () => {
      await expect(ingest.reindexChanges(codebaseDir)).rejects.toThrow("not indexed");
    });

    it("sweeps orphaned versioned collections left by killed runs (55xk2)", async () => {
      // A run killed mid-index leaves its versioned target behind (no alias
      // points at it). Only the force path used to sweep those — an
      // incremental reindex must reclaim them too, without touching the
      // active alias target.
      await createTestFile(codebaseDir, "orph.ts", "export const x = 1;");
      await ingest.indexCodebase(codebaseDir);
      const status = await ingest.getIndexStatus(codebaseDir);
      const base = status.collectionName!;
      await (qdrant as any).createCollection(`${base}_v99`, 384, "Cosine", false);

      await createTestFile(codebaseDir, "orph2.ts", "export const y = 2;");
      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.status).toBe("completed");
      const collections = (await (qdrant as any).listCollections()) as string[];
      expect(collections).not.toContain(`${base}_v99`);
      expect(collections.some((c) => c.startsWith(`${base}_v`))).toBe(true);
    });

    it("sweeps orphans even on a no-changes reindex (bare rerun reclaims leftovers)", async () => {
      await createTestFile(codebaseDir, "orphnc.ts", "export const x = 1;");
      await ingest.indexCodebase(codebaseDir);
      const status = await ingest.getIndexStatus(codebaseDir);
      const base = status.collectionName!;
      await (qdrant as any).createCollection(`${base}_v99`, 384, "Cosine", false);

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.status).toBe("completed");
      const collections = (await (qdrant as any).listCollections()) as string[];
      expect(collections).not.toContain(`${base}_v99`);
    });

    it("addresses enrichment by the physical versioned collection, not the alias (6goqa)", async () => {
      // The codegraph pool opens its DuckDB file by LITERAL name (pathFor), so
      // handing it the Qdrant alias writes a shadow <alias>.duckdb that no
      // reader ever opens. Qdrant itself resolves either name, which is why
      // this only shows up at the enrichment seam.
      await createTestFile(codebaseDir, "cg1.ts", "export const x = 1;");
      await ingest.indexCodebase(codebaseDir);
      const status = await ingest.getIndexStatus(codebaseDir);
      const alias = status.collectionName!;

      const beginRunSpy = vi.spyOn(EnrichmentCoordinator.prototype, "beginRun");
      await createTestFile(codebaseDir, "cg2.ts", "export const y = 2;");
      await ingest.reindexChanges(codebaseDir);

      const addressed = beginRunSpy.mock.calls.map((c) => c[1]);
      expect(addressed.length).toBeGreaterThan(0);
      expect(addressed).not.toContain(alias);
      expect(addressed.every((n) => typeof n === "string" && /_v\d+$/.test(n))).toBe(true);

      beginRunSpy.mockRestore();
    });

    it("should detect and index new files", async () => {
      await createTestFile(
        codebaseDir,
        "file1.ts",
        `export const initialValue = 1;
console.log('Initial file created');
function helper(param: string): boolean {
  console.log('Processing:', param);
  return true;
}`,
      );
      await ingest.indexCodebase(codebaseDir);

      await createTestFile(
        codebaseDir,
        "file2.ts",
        [
          "export function process(data: number): number {",
          "  console.log('Processing data with value:', data);",
          "  const multiplier = 42;",
          "  const result = data * multiplier;",
          "  console.log('Computed result:', result);",
          "  if (result > 100) {",
          "    console.log('Result is large');",
          "  }",
          "  return result;",
          "}",
          "",
          "export function validate(input: string): boolean {",
          "  if (!input || input.length === 0) {",
          "    console.log('Invalid input');",
          "    return false;",
          "  }",
          "  console.log('Valid input');",
          "  return input.length > 5;",
          "}",
        ].join("\n"),
      );

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesAdded).toBe(1);
      expect(stats.chunksAdded).toBeGreaterThan(0);
    });

    it("should detect modified files", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const originalValue = 1;\nconsole.log('Original');");
      await ingest.indexCodebase(codebaseDir);

      await createTestFile(codebaseDir, "test.ts", "export const updatedValue = 2;\nconsole.log('Updated');");

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesModified).toBe(1);
    });

    it("should detect deleted files", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const toBeDeleted = 1;\nconsole.log('Will be deleted');");
      await ingest.indexCodebase(codebaseDir);

      await fs.unlink(join(codebaseDir, "test.ts"));

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesDeleted).toBe(1);
    });

    it("should handle no changes", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const unchangedValue = 1;\nconsole.log('No changes');");
      await ingest.indexCodebase(codebaseDir);

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesAdded).toBe(0);
      expect(stats.filesModified).toBe(0);
      expect(stats.filesDeleted).toBe(0);
    });

    it("should call progress callback during reindexing", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const existingValue = 1;\nconsole.log('Existing');");
      await ingest.indexCodebase(codebaseDir);

      await createTestFile(codebaseDir, "new.ts", "export const newValue = 2;\nconsole.log('New file');");

      const progressCallback = vi.fn();
      await ingest.reindexChanges(codebaseDir, progressCallback);

      expect(progressCallback).toHaveBeenCalled();
    });

    it("should delete old chunks when file is modified", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export const originalValue = 1;\nconsole.log('Original version');\nconst extra = 'padding to make this file longer than 100 characters for fallback chunker';",
      );
      await ingest.indexCodebase(codebaseDir);

      const deletePointsByPathsSpy = vi.spyOn(qdrant, "deletePointsByPaths");

      await createTestFile(
        codebaseDir,
        "test.ts",
        "export const modifiedValue = 2;\nconsole.log('Modified version');\nconst extra = 'this is different content with a different length to trigger change detection correctly';",
      );

      await ingest.reindexChanges(codebaseDir);

      expect(deletePointsByPathsSpy).toHaveBeenCalledWith(
        expect.stringContaining("code_"),
        expect.arrayContaining(["test.ts"]),
      );
    });

    it("should delete all chunks when file is deleted", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const toDelete = 1;\nconsole.log('Will be deleted');");
      await ingest.indexCodebase(codebaseDir);

      const deletePointsByPathsSpy = vi.spyOn(qdrant, "deletePointsByPaths");

      await fs.unlink(join(codebaseDir, "test.ts"));

      await ingest.reindexChanges(codebaseDir);

      expect(deletePointsByPathsSpy).toHaveBeenCalledWith(
        expect.stringContaining("code_"),
        expect.arrayContaining(["test.ts"]),
      );
    });

    it("should not affect chunks from unchanged files", async () => {
      await createTestFile(
        codebaseDir,
        "unchanged.ts",
        "export const unchanged = 1;\nconsole.log('Unchanged');\nconst padding = 'extra content to ensure file is larger than 100 chars for fallback chunker';",
      );
      await createTestFile(
        codebaseDir,
        "changed.ts",
        "export const original = 2;\nconsole.log('Original');\nconst padding = 'extra content to ensure file is larger than 100 chars for fallback chunker';",
      );
      await ingest.indexCodebase(codebaseDir);

      const deletePointsByPathsSpy = vi.spyOn(qdrant, "deletePointsByPaths");

      await createTestFile(
        codebaseDir,
        "changed.ts",
        "export const modified = 3;\nconsole.log('Modified');\nconst differentPadding = 'completely different content with different length to trigger change detection';",
      );

      await ingest.reindexChanges(codebaseDir);

      expect(deletePointsByPathsSpy).toHaveBeenCalledWith(
        expect.stringContaining("code_"),
        expect.arrayContaining(["changed.ts"]),
      );
      const deletedPaths = deletePointsByPathsSpy.mock.calls[0]?.[1] || [];
      expect(deletedPaths).not.toContain("unchanged.ts");
    });

    it("should handle deletion errors gracefully", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export const original = 1;\nconsole.log('Original');\nconst padding = 'extra content to ensure file is larger than 100 chars for fallback chunker';",
      );
      await ingest.indexCodebase(codebaseDir);

      const deletePointsByPathsSpy = vi
        .spyOn(qdrant, "deletePointsByPaths")
        .mockRejectedValueOnce(new Error("Deletion failed"));

      await createTestFile(
        codebaseDir,
        "test.ts",
        "export const modified = 2;\nconsole.log('Modified');\nconst differentPadding = 'completely different content with different length to trigger change';",
      );

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(deletePointsByPathsSpy).toHaveBeenCalled();
      expect(stats.filesModified).toBe(1);
    });

    it("skips modified-file upsert when deletion L2 fails for that path", async () => {
      // Two modified files; force the deletion cascade to L2, then fail
      // only the filter-based delete for "blocked.ts".
      await createTestFile(
        codebaseDir,
        "blocked.ts",
        "export const blockedOriginal = 1;\nconsole.log('Blocked original');\nconst pad = 'padding content to meet the chunker minimum size threshold';",
      );
      await createTestFile(
        codebaseDir,
        "allowed.ts",
        "export const allowedOriginal = 1;\nconsole.log('Allowed original');\nconst pad = 'padding content to meet the chunker minimum size threshold';",
      );
      await ingest.indexCodebase(codebaseDir);

      // Force L2 cascade: batched + bulk deletes both fail.
      vi.spyOn(qdrant, "deletePointsByPathsBatched").mockRejectedValueOnce(new Error("batched failed"));
      vi.spyOn(qdrant, "deletePointsByPaths").mockRejectedValueOnce(new Error("bulk failed"));

      // In L2, per-path deletePointsByFilter is called for each path.
      // Fail only for blocked.ts; succeed for allowed.ts.
      vi.spyOn(qdrant, "deletePointsByFilter").mockImplementation(async (_collection, filter) => {
        const path = (filter as { must?: { match?: { value?: string } }[] }).must?.[0]?.match?.value;
        if (path === "blocked.ts") throw new Error("L2 delete failed for blocked.ts");
      });

      // Modify both files.
      await createTestFile(
        codebaseDir,
        "blocked.ts",
        "export const blockedNew = 2;\nconsole.log('Blocked new');\nconst pad = 'different padding content to trigger change detection properly now';",
      );
      await createTestFile(
        codebaseDir,
        "allowed.ts",
        "export const allowedNew = 2;\nconsole.log('Allowed new');\nconst pad = 'different padding content to trigger change detection properly now';",
      );

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesModified).toBe(2);
      expect(stats.filesSkippedDueToDeleteFailure).toBe(1);
      expect(stats.status).toBe("partial");
    });

    it("does not set filesSkippedDueToDeleteFailure when all deletes succeed", async () => {
      await createTestFile(
        codebaseDir,
        "clean.ts",
        "export const cleanOriginal = 1;\nconsole.log('Clean original');\nconst pad = 'padding content to meet the chunker minimum size threshold';",
      );
      await ingest.indexCodebase(codebaseDir);

      await createTestFile(
        codebaseDir,
        "clean.ts",
        "export const cleanNew = 2;\nconsole.log('Clean new');\nconst pad = 'different padding content to trigger change detection properly now';",
      );

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesModified).toBe(1);
      expect(stats.filesSkippedDueToDeleteFailure).toBeUndefined();
      expect(stats.status).toBe("completed");
    });
  });

  describe("indexing marker update", () => {
    it("should update completedAt timestamp after incremental reindex", async () => {
      await createTestFile(codebaseDir, "file1.ts", "export const v1 = 1;\nconsole.log('Initial');");
      await ingest.indexCodebase(codebaseDir);

      // Record the completedAt from initial indexing
      const status = await ingest.getIndexStatus(codebaseDir);
      expect(status.lastUpdated).toBeDefined();
      const completedAtBefore = status.lastUpdated!.getTime();

      // Wait 10ms to ensure timestamp differs
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add a new file and reindex
      await createTestFile(codebaseDir, "file2.ts", "export const v2 = 2;\nconsole.log('Added');");
      await ingest.reindexChanges(codebaseDir);

      // Verify completedAt was updated
      const statusAfter = await ingest.getIndexStatus(codebaseDir);
      expect(statusAfter.lastUpdated).toBeDefined();
      expect(statusAfter.lastUpdated!.getTime()).toBeGreaterThan(completedAtBefore);
    });

    it("should update completedAt even when no changes detected", async () => {
      await createTestFile(codebaseDir, "file1.ts", "export const v1 = 1;\nconsole.log('Initial');");
      await ingest.indexCodebase(codebaseDir);

      const status = await ingest.getIndexStatus(codebaseDir);
      const completedAtBefore = status.lastUpdated!.getTime();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Reindex with no changes
      const stats = await ingest.reindexChanges(codebaseDir);
      expect(stats.filesAdded).toBe(0);
      expect(stats.filesModified).toBe(0);
      expect(stats.filesDeleted).toBe(0);

      const statusAfter = await ingest.getIndexStatus(codebaseDir);
      expect(statusAfter.lastUpdated!.getTime()).toBeGreaterThan(completedAtBefore);
    });
  });

  describe("Progress callback coverage", () => {
    it("should call progress callback during reindexChanges", async () => {
      await createTestFile(codebaseDir, "file1.ts", "export const initial = 1;\nconsole.log('Initial');");
      await ingest.indexCodebase(codebaseDir);

      await createTestFile(
        codebaseDir,
        "file2.ts",
        `export const added = 2;
console.log('Added file');

export function process() {
  console.log('Processing');
  return true;
}`,
      );

      const progressUpdates: string[] = [];
      const progressCallback = (progress: any) => {
        progressUpdates.push(progress.phase);
      };

      await ingest.reindexChanges(codebaseDir, progressCallback);

      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates).toContain("scanning");
    });
  });

  describe("Secret detection skip path", () => {
    it("should skip files containing secrets during reindex", async () => {
      await createTestFile(codebaseDir, "safe.ts", "export const safeValue = 1;\nconsole.log('Safe file');");
      await ingest.indexCodebase(codebaseDir);

      // Add a file containing a secret pattern
      await createTestFile(
        codebaseDir,
        "secrets.ts",
        `export const config = {
  api_key = 'sk-1234567890abcdefghijklmnopqrstuvwxyz',
  endpoint: 'https://api.example.com',
};
console.log('This file has secrets');`,
      );

      const stats = await ingest.reindexChanges(codebaseDir);

      // File is detected as added but chunks should be 0 for it since it's skipped
      expect(stats.filesAdded).toBe(1);
      // The secret file is found but its chunks are not indexed (skipped silently)
      // chunksAdded may be 0 since the only new file has secrets
      expect(stats.status).toBe("completed");
    });
  });

  describe("File processing error handler", () => {
    it("should handle file read errors gracefully during reindex", async () => {
      await createTestFile(codebaseDir, "good.ts", "export const good = 1;\nconsole.log('Good file');");
      await ingest.indexCodebase(codebaseDir);

      // Create a new file that will be detected as added
      await createTestFile(codebaseDir, "newfile.ts", "export const newValue = 2;\nconsole.log('New');");

      // Delete the file AFTER scanner detects it but before it reads it,
      // simulating a race condition. Since we can't easily mock the exact
      // timing, we delete the file right after creating it - the scanner
      // has already picked up the hash, but readFile will fail.
      await fs.unlink(join(codebaseDir, "newfile.ts"));

      // Should not throw - the error handler catches per-file errors
      const stats = await ingest.reindexChanges(codebaseDir);
      // The file was detected as deleted (not added, since it's gone)
      expect(stats.status).toBe("completed");
    });
  });

  describe("schema migration during reindex", () => {
    it("should run snapshot and schema migrations via Migrator.run()", async () => {
      await createTestFile(codebaseDir, "file1.ts", "export const v1 = 1;\nconsole.log('Initial');");
      await ingest.indexCodebase(codebaseDir);

      // Spy on Migrator.run to verify both pipelines are invoked during reindex
      const runSpy = vi.spyOn(Migrator.prototype, "run");

      await createTestFile(codebaseDir, "file2.ts", "export const v2 = 2;\nconsole.log('Added');");

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(runSpy).toHaveBeenCalledWith("snapshot");
      expect(runSpy).toHaveBeenCalledWith("schema");
      expect(stats.filesAdded).toBe(1);

      runSpy.mockRestore();
    });

    it("should run the stats migration via Migrator.run()", async () => {
      await createTestFile(codebaseDir, "file1.ts", "export const v1 = 1;\nconsole.log('Initial');");
      await ingest.indexCodebase(codebaseDir);

      const runSpy = vi.spyOn(Migrator.prototype, "run");

      await createTestFile(codebaseDir, "file2.ts", "export const v2 = 2;\nconsole.log('Added');");
      await ingest.reindexChanges(codebaseDir);

      // The score background backfills an existing stats file without touching
      // embeddings — it belongs on the migration sweep, not behind a reindex
      // prompt the user has no way to know they need.
      expect(runSpy).toHaveBeenCalledWith("stats");

      runSpy.mockRestore();
    });
  });

  describe("no snapshot error", () => {
    it("should throw when no previous snapshot exists", async () => {
      await createTestFile(codebaseDir, "file1.ts", "export const v1 = 1;\nconsole.log('Initial');");
      await ingest.indexCodebase(codebaseDir);

      // Spy on initialize to return false (no snapshot found)
      const initializeSpy = vi.spyOn(ParallelFileSynchronizer.prototype, "initialize").mockResolvedValueOnce(false);

      await expect(ingest.reindexChanges(codebaseDir)).rejects.toThrow("Snapshot not found");

      initializeSpy.mockRestore();
    });
  });

  describe("checkpoint resume", () => {
    it("should resume from checkpoint when one exists", async () => {
      await createTestFile(codebaseDir, "file1.ts", "export const v1 = 1;\nconsole.log('Initial');");
      await ingest.indexCodebase(codebaseDir);

      // Spy on loadCheckpoint to return a valid checkpoint
      const loadCheckpointSpy = vi.spyOn(ParallelFileSynchronizer.prototype, "loadCheckpoint").mockResolvedValueOnce({
        processedFiles: ["file1.ts"],
        totalFiles: 2,
        timestamp: Date.now(),
      });

      await createTestFile(codebaseDir, "file2.ts", "export const v2 = 2;\nconsole.log('Added');");

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(loadCheckpointSpy).toHaveBeenCalled();
      expect(stats.filesAdded).toBe(1);

      loadCheckpointSpy.mockRestore();
    });
  });

  describe("ignore pattern changes", () => {
    it("should remove file from index when added to .contextignore", async () => {
      await createTestFile(codebaseDir, "keep.ts", "export const keep = 1;\nconsole.log('Keep this');");
      await createTestFile(codebaseDir, "ignored.ts", "export const ignored = 2;\nconsole.log('Will be ignored');");
      await ingest.indexCodebase(codebaseDir);

      // Add ignored.ts to .contextignore
      await fs.writeFile(join(codebaseDir, ".contextignore"), "ignored.ts\n");

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesDeleted).toBe(1);
      expect(stats.filesNewlyIgnored).toBe(1);
    });

    it("should add file to index when removed from .contextignore", async () => {
      // Create .contextignore BEFORE indexing so the file is excluded
      await fs.writeFile(join(codebaseDir, ".contextignore"), "unignored.ts\n");
      await createTestFile(codebaseDir, "keep.ts", "export const keep = 1;\nconsole.log('Keep this');");
      await createTestFile(codebaseDir, "unignored.ts", "export const unignored = 2;\nconsole.log('Was ignored');");
      await ingest.indexCodebase(codebaseDir);

      // Remove the ignore pattern
      await fs.writeFile(join(codebaseDir, ".contextignore"), "\n");

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesAdded).toBe(1);
      expect(stats.filesNewlyUnignored).toBe(1);
    });

    it("should handle both ignored and unignored files in same reindex", async () => {
      await fs.writeFile(join(codebaseDir, ".contextignore"), "was-ignored.ts\n");
      await createTestFile(codebaseDir, "will-be-ignored.ts", "export const a = 1;\nconsole.log('Will be ignored');");
      await createTestFile(codebaseDir, "was-ignored.ts", "export const b = 2;\nconsole.log('Was ignored');");
      await createTestFile(codebaseDir, "stable.ts", "export const c = 3;\nconsole.log('Stays');");
      await ingest.indexCodebase(codebaseDir);

      // Swap ignore patterns: ignore will-be-ignored.ts, unignore was-ignored.ts
      await fs.writeFile(join(codebaseDir, ".contextignore"), "will-be-ignored.ts\n");

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesNewlyIgnored).toBe(1);
      expect(stats.filesNewlyUnignored).toBe(1);
    });

    it("should not count truly deleted files as newly ignored", async () => {
      await createTestFile(codebaseDir, "keep.ts", "export const keep = 1;\nconsole.log('Keep');");
      await createTestFile(codebaseDir, "deleted.ts", "export const del = 2;\nconsole.log('Delete');");
      await ingest.indexCodebase(codebaseDir);

      // Actually delete the file (not just ignore it)
      await fs.unlink(join(codebaseDir, "deleted.ts"));

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesDeleted).toBe(1);
      expect(stats.filesNewlyIgnored).toBe(0);
    });
  });

  describe("deletion-only reindex", () => {
    it("should skip enrichment and complete quickly when only files are deleted", async () => {
      await createTestFile(codebaseDir, "file1.ts", "export const v1 = 1;\nconsole.log('File one');");
      await createTestFile(codebaseDir, "file2.ts", "export const v2 = 2;\nconsole.log('File two');");
      await ingest.indexCodebase(codebaseDir);

      // Delete both files — deletion-only scenario
      await fs.unlink(join(codebaseDir, "file1.ts"));
      await fs.unlink(join(codebaseDir, "file2.ts"));

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesDeleted).toBe(2);
      expect(stats.filesAdded).toBe(0);
      expect(stats.filesModified).toBe(0);
      expect(stats.enrichmentStatus).toBe("skipped");
      expect(stats.status).toBe("completed");
    });

    it("should not call enrichment prefetch when only deleting files", async () => {
      await createTestFile(codebaseDir, "file1.ts", "export const v1 = 1;\nconsole.log('File one');");
      await ingest.indexCodebase(codebaseDir);

      // Spy on enrichment coordinator prefetch — must NOT be called for deletion-only
      const prefetchSpy = vi.spyOn(EnrichmentCoordinator.prototype, "beginRun");

      await fs.unlink(join(codebaseDir, "file1.ts"));

      const stats = await ingest.reindexChanges(codebaseDir);

      // Deletion should complete
      expect(stats.filesDeleted).toBe(1);
      // Enrichment prefetch must NOT have been called (no pipeline init for deletion-only)
      expect(prefetchSpy).not.toHaveBeenCalled();

      prefetchSpy.mockRestore();
    });

    it("should update snapshot after deletion-only reindex", async () => {
      await createTestFile(codebaseDir, "file1.ts", "export const v1 = 1;\nconsole.log('File one');");
      await createTestFile(codebaseDir, "keep.ts", "export const keep = 1;\nconsole.log('Keep this');");
      await ingest.indexCodebase(codebaseDir);

      await fs.unlink(join(codebaseDir, "file1.ts"));

      const stats = await ingest.reindexChanges(codebaseDir);
      expect(stats.filesDeleted).toBe(1);

      // Second reindex should see no changes (snapshot updated correctly)
      const stats2 = await ingest.reindexChanges(codebaseDir);
      expect(stats2.filesDeleted).toBe(0);
      expect(stats2.filesAdded).toBe(0);
    });

    it("should handle ignore-only changes as deletion-only", async () => {
      await createTestFile(codebaseDir, "keep.ts", "export const keep = 1;\nconsole.log('Keep');");
      await createTestFile(codebaseDir, "ignored.ts", "export const ignored = 2;\nconsole.log('Will be ignored');");
      await ingest.indexCodebase(codebaseDir);

      // Add to .contextignore — this moves ignored.ts to deleted, nothing added
      await fs.writeFile(join(codebaseDir, ".contextignore"), "ignored.ts\n");

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesDeleted).toBe(1);
      expect(stats.filesNewlyIgnored).toBe(1);
      expect(stats.filesAdded).toBe(0);
      expect(stats.enrichmentStatus).toBe("skipped");
    });
  });

  // bd tea-rags-mcp-gvw8h — the repair pass used to sit BELOW both early
  // returns, so the one run that could have noticed a drifted provider store
  // (nothing changed, nothing to chunk) was the one run that skipped the check.
  // A repo that went quiet never healed: whoever spotted find_cycles serving a
  // dead cycle could not fix it by re-running the reindex.
  describe("self-healing repair on a run with nothing to chunk (gvw8h)", () => {
    it("checks the provider stores for drift even when no file changed", async () => {
      await createTestFile(codebaseDir, "steady.ts", "export const steady = 1;\nconsole.log('Steady');");
      await ingest.indexCodebase(codebaseDir);

      const repairSpy = vi.spyOn(EnrichmentCoordinator.prototype, "runRepairPass");

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesAdded).toBe(0);
      expect(stats.filesModified).toBe(0);
      expect(stats.filesDeleted).toBe(0);
      expect(repairSpy).toHaveBeenCalledTimes(1);
      const [collection, root, hashes] = repairSpy.mock.calls[0] as [string, string, Map<string, string>];
      // Physical target, not the alias — the store the codegraph DuckDB opens.
      expect(collection).toMatch(/_v\d+$/);
      // validatePath resolves symlinks (/var → /private/var on macOS).
      expect(root).toBe(await fs.realpath(codebaseDir));
      // Hashes come from the scan detectChanges just did, so nothing is re-read.
      expect(hashes.has("steady.ts")).toBe(true);

      repairSpy.mockRestore();
    });

    it("drives the enrichment finalize when the repair re-extracted files", async () => {
      await createTestFile(codebaseDir, "drifted.ts", "export const drifted = 1;\nconsole.log('Drifted');");
      await ingest.indexCodebase(codebaseDir);

      // A repair writes base rows; only the finalize turns them back into the
      // derived tables (cg_symbols_cycles / cg_symbols_metrics) and closes the
      // run the extraction opened.
      const repairSpy = vi.spyOn(EnrichmentCoordinator.prototype, "runRepairPass").mockResolvedValue(2);
      const beginRunSpy = vi.spyOn(EnrichmentCoordinator.prototype, "beginRun");
      const awaitCompletionSpy = vi.spyOn(EnrichmentCoordinator.prototype, "awaitCompletion");

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesAdded).toBe(0);
      expect(stats.filesModified).toBe(0);
      expect(beginRunSpy).toHaveBeenCalledTimes(1);
      expect(awaitCompletionSpy).toHaveBeenCalledTimes(1);
      // Addressed by the physical target, same as every other enrichment seam.
      expect(beginRunSpy.mock.calls[0]?.[1]).toMatch(/_v\d+$/);

      repairSpy.mockRestore();
      beginRunSpy.mockRestore();
      awaitCompletionSpy.mockRestore();
    });

    it("opens no enrichment run when nothing drifted, so an untouched repo stays cheap", async () => {
      await createTestFile(codebaseDir, "quiet.ts", "export const quiet = 1;\nconsole.log('Quiet');");
      await ingest.indexCodebase(codebaseDir);

      const repairSpy = vi.spyOn(EnrichmentCoordinator.prototype, "runRepairPass").mockResolvedValue(0);
      const beginRunSpy = vi.spyOn(EnrichmentCoordinator.prototype, "beginRun");

      await ingest.reindexChanges(codebaseDir);

      expect(repairSpy).toHaveBeenCalledTimes(1);
      expect(beginRunSpy).not.toHaveBeenCalled();

      repairSpy.mockRestore();
      beginRunSpy.mockRestore();
    });

    it("reports a failed repair finalize without failing the reindex", async () => {
      await createTestFile(codebaseDir, "unlucky.ts", "export const unlucky = 1;\nconsole.log('Unlucky');");
      await ingest.indexCodebase(codebaseDir);

      const repairSpy = vi.spyOn(EnrichmentCoordinator.prototype, "runRepairPass").mockResolvedValue(1);
      const finalizeSpy = vi
        .spyOn(EnrichmentCoordinator.prototype, "runFinalizeOnly")
        .mockRejectedValue(new Error("graph resolve blew up"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const stats = await ingest.reindexChanges(codebaseDir);

        // Enrichment failures are reported through the markers and the log, the
        // same as on the chunk path — a self-heal that could not finish must not
        // turn an otherwise-clean reindex into a hard error.
        expect(stats.status).toBe("completed");
        expect(stats.enrichmentStatus).toBe("failed");
        expect(finalizeSpy).toHaveBeenCalledTimes(1);
        expect(
          errorSpy.mock.calls.some((call) =>
            call.some((arg) => typeof arg === "string" && arg.includes("Repair finalize failed")),
          ),
        ).toBe(true);
      } finally {
        repairSpy.mockRestore();
        finalizeSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("finalizes a deletion-only reindex that repaired something", async () => {
      await createTestFile(codebaseDir, "keep.ts", "export const keep = 1;\nconsole.log('Keep');");
      await createTestFile(codebaseDir, "gone.ts", "export const gone = 2;\nconsole.log('Gone');");
      await ingest.indexCodebase(codebaseDir);

      const repairSpy = vi.spyOn(EnrichmentCoordinator.prototype, "runRepairPass").mockResolvedValue(1);
      const beginRunSpy = vi.spyOn(EnrichmentCoordinator.prototype, "beginRun");

      await fs.unlink(join(codebaseDir, "gone.ts"));

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.filesDeleted).toBe(1);
      expect(stats.filesAdded).toBe(0);
      expect(stats.filesModified).toBe(0);
      expect(beginRunSpy).toHaveBeenCalledTimes(1);

      repairSpy.mockRestore();
      beginRunSpy.mockRestore();
    });
  });

  describe("enrichment scope during reindex", () => {
    it("should pass changed file paths to enrichment prefetch", async () => {
      await createTestFile(codebaseDir, "existing.ts", "export const v1 = 1;\nconsole.log('Existing');");
      await ingest.indexCodebase(codebaseDir);

      const prefetchSpy = vi.spyOn(EnrichmentCoordinator.prototype, "beginRun");

      // Add a new file — enrichment should only prefetch for this file
      await createTestFile(
        codebaseDir,
        "newfile.ts",
        "export const v2 = 2;\nconsole.log('New');\nfunction helper() { return true; }",
      );

      await ingest.reindexChanges(codebaseDir);

      expect(prefetchSpy).toHaveBeenCalledTimes(1);
      // 4th argument should be the changedPaths array containing only the new file
      const changedPaths = prefetchSpy.mock.calls[0]?.[3];
      expect(changedPaths).toBeDefined();
      expect(changedPaths).toContain("newfile.ts");
      expect(changedPaths).not.toContain("existing.ts");

      prefetchSpy.mockRestore();
    });

    it("should pass both added and modified files to enrichment prefetch", async () => {
      await createTestFile(
        codebaseDir,
        "modify-me.ts",
        "export const v1 = 1;\nconsole.log('Original version of the file');\nconst padding = 'extra content to ensure hash differs';",
      );
      await ingest.indexCodebase(codebaseDir);

      const prefetchSpy = vi.spyOn(EnrichmentCoordinator.prototype, "beginRun");

      // Modify existing (different content = different hash) + add new
      await createTestFile(
        codebaseDir,
        "modify-me.ts",
        "export const v2 = 2;\nconsole.log('Modified version of the file');\nconst padding = 'completely different content for hash change';",
      );
      await createTestFile(
        codebaseDir,
        "added.ts",
        "export const v3 = 3;\nconsole.log('Added');\nfunction helper() { return true; }",
      );

      await ingest.reindexChanges(codebaseDir);

      expect(prefetchSpy).toHaveBeenCalledTimes(1);
      const changedPaths = prefetchSpy.mock.calls[0]?.[3];
      expect(changedPaths).toBeDefined();
      expect(changedPaths).toContain("modify-me.ts");
      expect(changedPaths).toContain("added.ts");

      prefetchSpy.mockRestore();
    });

    it("passes the DELTA size as the file-progress denominator, not the full scan (tea-rags-mcp-d0aqv)", async () => {
      // Live symptom: a 4 574-file delta on a 25 531-file project rendered as
      // "git file 2458/25531 (10%) ~25.3m" — the full-scan count as denominator
      // makes an incremental run look like a whole-repo recompute and the ETA
      // extrapolates to files that will never stream.
      await createTestFile(codebaseDir, "one.ts", "export const a = 1;\nconsole.log('one');");
      await createTestFile(codebaseDir, "two.ts", "export const b = 2;\nconsole.log('two');");
      await createTestFile(codebaseDir, "three.ts", "export const c = 3;\nconsole.log('three');");
      await ingest.indexCodebase(codebaseDir);

      const prefetchSpy = vi.spyOn(EnrichmentCoordinator.prototype, "beginRun");

      await createTestFile(codebaseDir, "one.ts", "export const a = 11;\nconsole.log('one changed substantially');");

      await ingest.reindexChanges(codebaseDir);

      expect(prefetchSpy).toHaveBeenCalledTimes(1);
      const fileCount = prefetchSpy.mock.calls[0]?.[5];
      // 1 modified file out of 3 on disk — the denominator is the delta.
      expect(fileCount).toBe(1);

      prefetchSpy.mockRestore();
    });
  });

  describe("performDeletion fallback levels", () => {
    it("should fall through to L2 individual deletions when both batched and single delete fail", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export const original = 1;\nconsole.log('Original');\nconst padding = 'extra content for fallback chunker padding characters';",
      );
      await ingest.indexCodebase(codebaseDir);

      await createTestFile(
        codebaseDir,
        "test.ts",
        "export const modified = 2;\nconsole.log('Modified');\nconst padding = 'different content for change detection purposes here';",
      );

      // Make BOTH deletePointsByPathsBatched AND deletePointsByPaths fail
      // Must be set AFTER indexCodebase but BEFORE reindexChanges
      const batchedSpy = vi
        .spyOn(qdrant, "deletePointsByPathsBatched")
        .mockRejectedValueOnce(new Error("Batched delete failed"));
      const pathsSpy = vi
        .spyOn(qdrant, "deletePointsByPaths")
        .mockRejectedValueOnce(new Error("Single delete also failed"));
      const filterSpy = vi.spyOn(qdrant, "deletePointsByFilter");

      const stats = await ingest.reindexChanges(codebaseDir);

      // L0 (batched) should have been called and failed
      expect(batchedSpy).toHaveBeenCalled();
      // L1 (single) should have been called and failed
      expect(pathsSpy).toHaveBeenCalled();
      // L2 (individual filter-based) should have been called as last resort
      expect(filterSpy).toHaveBeenCalled();
      expect(stats.filesModified).toBe(1);
    });

    it("should handle L2 individual deletion failures gracefully", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export const original = 1;\nconsole.log('Original');\nconst padding = 'extra content for fallback chunker padding characters';",
      );
      await ingest.indexCodebase(codebaseDir);

      await createTestFile(
        codebaseDir,
        "test.ts",
        "export const modified = 2;\nconsole.log('Modified');\nconst padding = 'different content for change detection purposes here';",
      );

      // Make ALL deletion methods fail
      vi.spyOn(qdrant, "deletePointsByPathsBatched").mockRejectedValueOnce(new Error("Batched failed"));
      vi.spyOn(qdrant, "deletePointsByPaths").mockRejectedValueOnce(new Error("Single failed"));
      vi.spyOn(qdrant, "deletePointsByFilter").mockRejectedValue(new Error("Individual failed"));

      // Should still complete without throwing. Phase 3.2: when L2 fails for
      // a modified file, its upsert is skipped and the overall status is
      // downgraded to "partial" so callers can surface the degraded outcome.
      const stats = await ingest.reindexChanges(codebaseDir);
      expect(stats.filesModified).toBe(1);
      expect(stats.status).toBe("partial");
      expect(stats.filesSkippedDueToDeleteFailure).toBe(1);
    });
  });

  describe("deletion-only partial failure surfacing", () => {
    it("throws PartialDeletionError from deletion-only path when every level fails", async () => {
      await createTestFile(codebaseDir, "doomed.ts", "export const v1 = 1;\nconsole.log('Doomed file for deletion');");
      await ingest.indexCodebase(codebaseDir);

      // Delete the file locally so reindex sees it as deleted → triggers deletion-only path
      await fs.unlink(join(codebaseDir, "doomed.ts"));

      // Force total deletion failure through all 3 levels
      vi.spyOn(qdrant, "deletePointsByPathsBatched").mockRejectedValueOnce(new Error("L0 timeout"));
      vi.spyOn(qdrant, "deletePointsByPaths").mockRejectedValueOnce(new Error("L1 timeout"));
      vi.spyOn(qdrant, "deletePointsByFilter").mockRejectedValue(new Error("L2 per-file timeout"));

      // Typed errors propagate as-is through wrapUnexpectedError
      await expect(ingest.reindexChanges(codebaseDir)).rejects.toMatchObject({
        code: "INGEST_PARTIAL_DELETION",
      });
    });

    it("completes normally when deletion-only path fully succeeds", async () => {
      await createTestFile(codebaseDir, "safe.ts", "export const v1 = 1;\nconsole.log('Safe for deletion');");
      await ingest.indexCodebase(codebaseDir);

      await fs.unlink(join(codebaseDir, "safe.ts"));

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(stats.status).toBe("completed");
      expect(stats.filesDeleted).toBe(1);
    });

    it("PartialDeletionError carries the outcome with failed paths", async () => {
      await createTestFile(codebaseDir, "doomed.ts", "export const v1 = 1;\nconsole.log('Doomed file for deletion');");
      await ingest.indexCodebase(codebaseDir);

      await fs.unlink(join(codebaseDir, "doomed.ts"));

      vi.spyOn(qdrant, "deletePointsByPathsBatched").mockRejectedValueOnce(new Error("L0 timeout"));
      vi.spyOn(qdrant, "deletePointsByPaths").mockRejectedValueOnce(new Error("L1 timeout"));
      vi.spyOn(qdrant, "deletePointsByFilter").mockRejectedValue(new Error("L2 per-file timeout"));

      try {
        await ingest.reindexChanges(codebaseDir);
        throw new Error("expected rejection");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(PartialDeletionError);
        const partial = err as PartialDeletionError;
        expect(partial.outcome.failed.has("doomed.ts")).toBe(true);
        expect(partial.outcome.isFullSuccess()).toBe(false);
      }
    });
  });

  describe("resumeOptimizer failure is non-fatal", () => {
    it("should complete reindexChanges parallel-pipeline path when resumeOptimizer rejects in finally", async () => {
      // Setup: existing indexed file + new file → triggers executeParallelPipelines
      await createTestFile(
        codebaseDir,
        "existing.ts",
        "export const v1 = 1;\nconsole.log('Existing file with some content');",
      );
      await ingest.indexCodebase(codebaseDir);

      await createTestFile(
        codebaseDir,
        "added.ts",
        "export const v2 = 2;\nconsole.log('Added');\nfunction helper() { return true; }",
      );

      // resumeOptimizer rejects — finally block's .catch must swallow it
      const resumeSpy = vi
        .spyOn(qdrant, "resumeOptimizer")
        .mockRejectedValue(new Error("Qdrant 5xx: resumeOptimizer unavailable"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const stats = await ingest.reindexChanges(codebaseDir);

        // Parent method returns normally — no rethrow
        expect(stats.status).toBe("completed");
        expect(stats.filesAdded).toBe(1);
        expect(resumeSpy).toHaveBeenCalled();
        const loggedResumeFailure = errorSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === "string" && arg.includes("resumeOptimizer failed")),
        );
        expect(loggedResumeFailure).toBe(true);
      } finally {
        resumeSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("should complete deletion-only reindex when resumeOptimizer rejects in finally", async () => {
      await createTestFile(
        codebaseDir,
        "doomed.ts",
        "export const v1 = 1;\nconsole.log('Doomed file for deletion-only path');",
      );
      await ingest.indexCodebase(codebaseDir);

      // Delete file → triggers executeDeletionOnly (no added/modified)
      await fs.unlink(join(codebaseDir, "doomed.ts"));

      const resumeSpy = vi
        .spyOn(qdrant, "resumeOptimizer")
        .mockRejectedValue(new Error("Qdrant 5xx: resumeOptimizer unavailable"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const stats = await ingest.reindexChanges(codebaseDir);

        // Deletion-only path returns normally despite resume failure
        expect(stats.status).toBe("completed");
        expect(stats.filesDeleted).toBe(1);
        expect(resumeSpy).toHaveBeenCalled();
        const loggedResumeFailure = errorSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === "string" && arg.includes("resumeOptimizer failed")),
        );
        expect(loggedResumeFailure).toBe(true);
      } finally {
        resumeSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
});
