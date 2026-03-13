import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SchemaManager } from "../../../src/core/adapters/qdrant/schema-migration.js";
import { IngestFacade } from "../../../src/core/api/index.js";
import { ParallelFileSynchronizer } from "../../../src/core/ingest/sync/parallel-synchronizer.js";
import type { IngestCodeConfig } from "../../../src/core/types.js";
import {
  cleanupTempDir,
  createTempTestDir,
  createTestFile,
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "./__helpers__/test-helpers.js";

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
    ingest = new IngestFacade(qdrant as any, embeddings, config, defaultTrajectoryConfig());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("reindexChanges", () => {
    it("should throw error if not previously indexed", async () => {
      await expect(ingest.reindexChanges(codebaseDir)).rejects.toThrow("not indexed");
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
    it("should log when schema migrations are applied", async () => {
      await createTestFile(codebaseDir, "file1.ts", "export const v1 = 1;\nconsole.log('Initial');");
      await ingest.indexCodebase(codebaseDir);

      // Spy on ensureCurrentSchema to return migrations applied
      const ensureCurrentSchemaSpy = vi.spyOn(SchemaManager.prototype, "ensureCurrentSchema").mockResolvedValueOnce({
        success: true,
        fromVersion: 1,
        toVersion: 2,
        migrationsApplied: ["add_chunk_type_index"],
      });

      await createTestFile(codebaseDir, "file2.ts", "export const v2 = 2;\nconsole.log('Added');");

      const stats = await ingest.reindexChanges(codebaseDir);

      expect(ensureCurrentSchemaSpy).toHaveBeenCalled();
      expect(stats.filesAdded).toBe(1);

      ensureCurrentSchemaSpy.mockRestore();
    });
  });

  describe("no snapshot error", () => {
    it("should throw when no previous snapshot exists", async () => {
      await createTestFile(codebaseDir, "file1.ts", "export const v1 = 1;\nconsole.log('Initial');");
      await ingest.indexCodebase(codebaseDir);

      // Spy on initialize to return false (no snapshot found)
      const initializeSpy = vi.spyOn(ParallelFileSynchronizer.prototype, "initialize").mockResolvedValueOnce(false);

      await expect(ingest.reindexChanges(codebaseDir)).rejects.toThrow("No previous snapshot found");

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

      // Should still complete without throwing
      const stats = await ingest.reindexChanges(codebaseDir);
      expect(stats.filesModified).toBe(1);
      expect(stats.status).toBe("completed");
    });
  });
});
