/**
 * Collection creation sizes itself by what the provider actually emits.
 *
 * Cohere and Voyage expose no model-info API and send no dimension parameter, so
 * `resolveModelInfo` is undefined for them and the only remaining source is the
 * static model table. When that table is wrong — or simply lacks the model — the
 * COLLECTION itself is created at the wrong width and every upsert fails, which
 * is a harder failure than the marker bug. A single probe embedding settles it.
 */

import { describe, expect, it, vi } from "vitest";

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
vi.mock("tree-sitter-typescript", () => ({ default: { typescript: {}, tsx: {} } }));

/** A provider whose configured width disagrees with the vectors it emits. */
class DriftedWidthProvider extends MockEmbeddingProvider {
  static readonly REAL_WIDTH = 1024;

  getDimensions(): number {
    return 384; // the static-table guess
  }

  async embed(_text: string): Promise<{ embedding: number[]; dimensions: number }> {
    return {
      embedding: new Array(DriftedWidthProvider.REAL_WIDTH).fill(0.1),
      dimensions: DriftedWidthProvider.REAL_WIDTH,
    };
  }

  async embedBatch(texts: string[]): Promise<{ embedding: number[]; dimensions: number }[]> {
    return texts.map(() => ({
      embedding: new Array(DriftedWidthProvider.REAL_WIDTH).fill(0.1),
      dimensions: DriftedWidthProvider.REAL_WIDTH,
    }));
  }
}

describe("collection creation — vector width", () => {
  it("creates the collection at the width the provider actually emits", async () => {
    const { tempDir, codebaseDir } = await createTempTestDir();
    try {
      const qdrant = new MockQdrantManager() as any;
      const embeddings = new DriftedWidthProvider();
      const ingest = new IngestFacade({
        qdrant,
        embeddings,
        config: defaultTestConfig(),
        trajectoryConfig: defaultTrajectoryConfig(),
      });
      await createTestFile(codebaseDir, "probe.ts", "export const value = 1;");

      await ingest.indexCodebase(codebaseDir);

      const status = await ingest.getIndexStatus(codebaseDir);
      const info = await qdrant.getCollectionInfo(status.collectionName!);
      expect(info.vectorSize).toBe(DriftedWidthProvider.REAL_WIDTH);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it("falls back to the configured width when the provider cannot be probed", async () => {
    const { tempDir, codebaseDir } = await createTempTestDir();
    try {
      const qdrant = new MockQdrantManager() as any;
      const embeddings = new MockEmbeddingProvider();
      // A probe that throws must not break indexing — the configured width is
      // still the best available answer.
      vi.spyOn(embeddings, "embed").mockRejectedValueOnce(new Error("no api key"));
      const ingest = new IngestFacade({
        qdrant,
        embeddings,
        config: defaultTestConfig(),
        trajectoryConfig: defaultTrajectoryConfig(),
      });
      await createTestFile(codebaseDir, "probe.ts", "export const value = 1;");

      await ingest.indexCodebase(codebaseDir);

      const status = await ingest.getIndexStatus(codebaseDir);
      const info = await qdrant.getCollectionInfo(status.collectionName!);
      expect(info.vectorSize).toBe(embeddings.getDimensions());
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});
