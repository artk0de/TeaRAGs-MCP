import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { CodeIndexer } from "../../../src/code/indexer.js";
import type { CodeConfig } from "../../../src/code/types.js";
import {
  MockQdrantManager,
  MockEmbeddingProvider,
  createTestFile,
  defaultTestConfig,
  createTempTestDir,
  cleanupTempDir,
} from "./test-helpers.js";

describe("EnrichmentModule", () => {
  let indexer: CodeIndexer;
  let qdrant: MockQdrantManager;
  let embeddings: MockEmbeddingProvider;
  let config: CodeConfig;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager() as any;
    embeddings = new MockEmbeddingProvider();
    config = defaultTestConfig();
    indexer = new CodeIndexer(qdrant as any, embeddings, config);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("Two-phase indexing (git enrichment)", () => {
    it("should set enrichmentStatus to skipped when enableGitMetadata is false", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export function hello(): string { return 'hello'; }",
      );

      const stats = await indexer.indexCodebase(codebaseDir);

      expect(stats.status).toBe("completed");
      expect(stats.enrichmentStatus).toBe("skipped");
      expect(stats.enrichmentDurationMs).toBeUndefined();
    });

    it("should start background enrichment when enableGitMetadata is true", async () => {
      const gitConfig = { ...config, enableGitMetadata: true };
      const gitIndexer = new CodeIndexer(qdrant as any, embeddings, gitConfig);

      await createTestFile(
        codebaseDir,
        "test.ts",
        "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}",
      );

      const stats = await gitIndexer.indexCodebase(codebaseDir);

      expect(stats.status).toBe("completed");
      expect(stats.enrichmentStatus).toBe("background");
    });

    it("should not include git metadata in Phase 1 chunks", async () => {
      const gitConfig = { ...config, enableGitMetadata: true };
      const gitIndexer = new CodeIndexer(qdrant as any, embeddings, gitConfig);

      await createTestFile(
        codebaseDir,
        "test.ts",
        "export function calculate(x: number): number {\n  return x * 2;\n}",
      );

      const addPointsSpy = vi.spyOn(qdrant, "addPoints");
      const addPointsOptSpy = vi.spyOn(qdrant, "addPointsOptimized");
      const addSparseOptSpy = vi.spyOn(qdrant, "addPointsWithSparseOptimized");

      await gitIndexer.indexCodebase(codebaseDir);

      const allCalls = [
        ...addPointsSpy.mock.calls,
        ...addPointsOptSpy.mock.calls,
        ...addSparseOptSpy.mock.calls,
      ];

      for (const call of allCalls) {
        const points = call[1] as any[];
        for (const point of points) {
          if (point.payload?._type === "indexing_metadata") continue;
          expect(point.payload?.git).toBeUndefined();
        }
      }
    });

    it("should set enrichmentStatus to skipped in reindexChanges when enableGitMetadata is false", async () => {
      await createTestFile(
        codebaseDir,
        "initial.ts",
        "export const initialValue = 1;\nconsole.log('Initial');",
      );
      await indexer.indexCodebase(codebaseDir);

      await createTestFile(
        codebaseDir,
        "added.ts",
        "export function newFeature(): boolean {\n  console.log('New feature added');\n  return true;\n}",
      );

      const stats = await indexer.reindexChanges(codebaseDir);

      expect(stats.enrichmentStatus).toBe("skipped");
    });

    it("should start background enrichment in reindexChanges when enableGitMetadata is true", async () => {
      const gitConfig = { ...config, enableGitMetadata: true };
      const gitIndexer = new CodeIndexer(qdrant as any, embeddings, gitConfig);

      await createTestFile(
        codebaseDir,
        "initial.ts",
        "export const initialValue = 1;\nconsole.log('Initial file here');",
      );
      await gitIndexer.indexCodebase(codebaseDir);

      await createTestFile(
        codebaseDir,
        "added.ts",
        "export function addedFunc(): void {\n  console.log('Added function');\n  return;\n}",
      );

      const stats = await gitIndexer.reindexChanges(codebaseDir);

      expect(stats.enrichmentStatus).toBe("background");
    });

    it("should not call enriching progress callback (enrichment is background)", async () => {
      const gitConfig = { ...config, enableGitMetadata: true };
      const gitIndexer = new CodeIndexer(qdrant as any, embeddings, gitConfig);

      await createTestFile(
        codebaseDir,
        "test.ts",
        "export function hello(): string {\n  return 'hello world';\n}",
      );

      const progressCallback = vi.fn();
      await gitIndexer.indexCodebase(codebaseDir, undefined, progressCallback);

      const enrichingCalls = progressCallback.mock.calls.filter(
        (call) => call[0].phase === "enriching",
      );
      expect(enrichingCalls.length).toBe(0);
    });

    it("should start background enrichment for multiple files in indexCodebase", async () => {
      const gitConfig = { ...config, enableGitMetadata: true };
      const gitIndexer = new CodeIndexer(qdrant as any, embeddings, gitConfig);

      await createTestFile(codebaseDir, "a.ts", "export function funcA(x: number): number {\n  return x + 1;\n}");
      await createTestFile(codebaseDir, "b.ts", "export function funcB(y: string): string {\n  return y.trim();\n}");

      const stats = await gitIndexer.indexCodebase(codebaseDir);

      expect(stats.status).toBe("completed");
      expect(stats.enrichmentStatus).toBe("background");
    });

    it("should start background enrichment in reindexChanges for new files", async () => {
      const gitConfig = { ...config, enableGitMetadata: true };
      const gitIndexer = new CodeIndexer(qdrant as any, embeddings, gitConfig);

      await createTestFile(codebaseDir, "existing.ts", "export const x = 1;\nconsole.log('Existing file');");
      await gitIndexer.indexCodebase(codebaseDir);

      await createTestFile(codebaseDir, "new.ts", "export function newFunc(): void {\n  console.log('New');\n}");

      const stats = await gitIndexer.reindexChanges(codebaseDir);

      expect(stats.enrichmentStatus).toBe("background");
    });

    it("should respect GIT_ENRICHMENT_CONCURRENCY env override", async () => {
      const originalEnv = process.env.GIT_ENRICHMENT_CONCURRENCY;
      process.env.GIT_ENRICHMENT_CONCURRENCY = "5";

      try {
        const gitConfig = { ...config, enableGitMetadata: true };
        const gitIndexer = new CodeIndexer(qdrant as any, embeddings, gitConfig);

        await createTestFile(codebaseDir, "test.ts", "export function compute(x: number): number {\n  return x * 42;\n}");

        const stats = await gitIndexer.indexCodebase(codebaseDir);
        expect(stats.status).toBe("completed");
        expect(stats.enrichmentStatus).toBeDefined();
      } finally {
        if (originalEnv !== undefined) {
          process.env.GIT_ENRICHMENT_CONCURRENCY = originalEnv;
        } else {
          delete process.env.GIT_ENRICHMENT_CONCURRENCY;
        }
      }
    });
  });
});
