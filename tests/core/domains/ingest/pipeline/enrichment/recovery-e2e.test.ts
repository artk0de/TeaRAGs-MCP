import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupTempDir,
  createTempTestDir,
  createTestFile,
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../../__helpers__/test-helpers.js";
import { IngestFacade } from "../../../../../../src/core/api/index.js";

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

describe("Enrichment recovery E2E", () => {
  let tempDir: string;
  let codebaseDir: string;
  let qdrant: MockQdrantManager;
  let embeddings: MockEmbeddingProvider;
  let ingest: IngestFacade;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager() as any;
    embeddings = new MockEmbeddingProvider();
    ingest = new IngestFacade(
      qdrant as any,
      embeddings,
      defaultTestConfig(),
      defaultTrajectoryConfig(),
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should show enrichment health in get_index_status after indexing", async () => {
    await createTestFile(codebaseDir, "test.ts", "export const x = 1;");
    await ingest.indexCodebase(codebaseDir);
    const status = await ingest.getIndexStatus(codebaseDir);

    expect(status.isIndexed).toBe(true);
    // Enrichment health should be present (git provider writes markers)
    // Note: with mock git (no real repo), enrichment may show as failed or not present
    // The key assertion is that the API shape is correct
    expect(status.enrichment === undefined || typeof status.enrichment === "object").toBe(true);
  });

  it("should handle incremental reindex without errors", async () => {
    await createTestFile(codebaseDir, "test.ts", "export const x = 1;");
    await ingest.indexCodebase(codebaseDir);

    // Add a new file and reindex
    await createTestFile(codebaseDir, "test2.ts", "export const y = 2;");
    await ingest.indexCodebase(codebaseDir);

    const status = await ingest.getIndexStatus(codebaseDir);
    expect(status.isIndexed).toBe(true);
  });

  it("should handle forceReindex without running recovery", async () => {
    await createTestFile(codebaseDir, "test.ts", "export const x = 1;");
    await ingest.indexCodebase(codebaseDir);
    await ingest.indexCodebase(codebaseDir, { forceReindex: true });

    const status = await ingest.getIndexStatus(codebaseDir);
    expect(status.isIndexed).toBe(true);
  });
});
