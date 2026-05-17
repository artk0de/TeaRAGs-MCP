/**
 * Regression tests for ReindexPipeline.executeParallelPipelines partial-outcome
 * reporting contract. Pins behavior of Phase C (assessment) before decomposition
 * per M2.E.
 *
 * Bug class: partial-outcome counter drift. If the assess phase miscounts
 * skipped files or fails to set status="partial", callers silently get a
 * "completed" reindex even when files were skipped due to delete failure,
 * leaving stale chunks in the index.
 *
 * Original fix: 7fe355d8 fix(ingest): gate modified-file upsert on delete
 * success per file. These tests harden the counter beyond the single-path case
 * already covered in reindexing.test.ts, locking the Phase C contract:
 *   coordinator.hasBlockedPaths() -> filesSkippedDueToDeleteFailure: N
 *   AND stats.status === "partial" when N > 0.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IngestFacade } from "../../../../src/core/api/index.js";
import type { IngestCodeConfig } from "../../../../src/core/types.js";
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

describe("ReindexPipeline.executeParallelPipelines partial-outcome contract", () => {
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

  it("counts every modified file whose per-path L2 delete fails (multi-path drift guard)", async () => {
    // Three modified files, all of which fail L2 per-path delete. The Phase C
    // assess step must report filesSkippedDueToDeleteFailure === 3, not 1 or 2.
    // Without correct aggregation, callers see "partial" with a wrong count
    // and cannot reason about how much of the index is stale.
    const paths = ["alpha.ts", "beta.ts", "gamma.ts"];

    for (const p of paths) {
      await createTestFile(
        codebaseDir,
        p,
        `export const ${p.replace(".ts", "")}Original = 1;\nconsole.log('Original ${p}');\nconst pad = 'padding content to meet the chunker minimum size threshold here';`,
      );
    }
    await ingest.indexCodebase(codebaseDir);

    // Force the L2 cascade by failing batched + bulk deletes.
    vi.spyOn(qdrant, "deletePointsByPathsBatched").mockRejectedValueOnce(new Error("batched failed"));
    vi.spyOn(qdrant, "deletePointsByPaths").mockRejectedValueOnce(new Error("bulk failed"));
    // Per-path L2 delete fails for every path.
    vi.spyOn(qdrant, "deletePointsByFilter").mockRejectedValue(new Error("L2 per-path failed"));

    // Modify all three files so they enter the modified bucket.
    for (const p of paths) {
      await createTestFile(
        codebaseDir,
        p,
        `export const ${p.replace(".ts", "")}New = 2;\nconsole.log('New ${p}');\nconst pad = 'different padding content to trigger change detection properly now';`,
      );
    }

    const stats = await ingest.reindexChanges(codebaseDir);

    expect(stats.filesModified).toBe(3);
    // Phase C contract: every skipped file is counted exactly once.
    expect(stats.filesSkippedDueToDeleteFailure).toBe(3);
    expect(stats.status).toBe("partial");
  });

  it("reports 'partial' with non-zero skipped count when at least one delete fails (boundary guard)", async () => {
    // Exactly one modified file fails, two succeed. Phase C must NOT silently
    // round filesSkippedDueToDeleteFailure to 0 because the majority succeeded.
    // The status downgrade is binary — any blocked path means "partial".
    const paths = ["one.ts", "two.ts", "three.ts"];

    for (const p of paths) {
      await createTestFile(
        codebaseDir,
        p,
        `export const ${p.replace(".ts", "")}Original = 1;\nconsole.log('Original ${p}');\nconst pad = 'padding content to meet the chunker minimum size threshold here';`,
      );
    }
    await ingest.indexCodebase(codebaseDir);

    vi.spyOn(qdrant, "deletePointsByPathsBatched").mockRejectedValueOnce(new Error("batched failed"));
    vi.spyOn(qdrant, "deletePointsByPaths").mockRejectedValueOnce(new Error("bulk failed"));

    // Per-path L2: only "two.ts" fails; the other two succeed.
    vi.spyOn(qdrant, "deletePointsByFilter").mockImplementation(async (_collection, filter) => {
      const path = (filter as { must?: { match?: { value?: string } }[] }).must?.[0]?.match?.value;
      if (path === "two.ts") throw new Error("L2 delete failed for two.ts");
    });

    for (const p of paths) {
      await createTestFile(
        codebaseDir,
        p,
        `export const ${p.replace(".ts", "")}New = 2;\nconsole.log('New ${p}');\nconst pad = 'different padding content to trigger change detection properly now';`,
      );
    }

    const stats = await ingest.reindexChanges(codebaseDir);

    expect(stats.filesModified).toBe(3);
    // Exactly one path blocked — Phase C must surface it, not absorb it.
    expect(stats.filesSkippedDueToDeleteFailure).toBe(1);
    expect(stats.status).toBe("partial");
  });
});
