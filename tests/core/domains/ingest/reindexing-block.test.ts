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

import { promises as fs } from "node:fs";
import { join } from "node:path";

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
    qdrant = new MockQdrantManager();
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
      // The `value` half of the text+value pair (bd tea-rags-mcp-ivp12).
      const path = (filter as { must?: { match?: { value?: string } }[] }).must?.find(
        (c) => c.match?.value !== undefined,
      )?.match?.value;
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

  it("downgrades to 'partial' when only a removed file's L2 delete fails (no modified collision)", async () => {
    // bd tea-rags-mcp-fa9k: a path that left the disk has no upsert for the
    // coordinator to gate, so skippedFiles() stays empty. The failed delete
    // still leaves that file's old chunks in the index, so the run is not
    // "completed" — the removed-file failure must be counted on its own.
    const kept = "kept.ts";
    const removed = "removed.ts";
    for (const p of [kept, removed]) {
      await createTestFile(
        codebaseDir,
        p,
        `export const ${p.replace(".ts", "")}Original = 1;\nconsole.log('Original ${p}');\nconst pad = 'padding content to meet the chunker minimum size threshold here';`,
      );
    }
    await ingest.indexCodebase(codebaseDir);

    vi.spyOn(qdrant, "deletePointsByPathsBatched").mockRejectedValueOnce(new Error("batched failed"));
    vi.spyOn(qdrant, "deletePointsByPaths").mockRejectedValueOnce(new Error("bulk failed"));
    vi.spyOn(qdrant, "deletePointsByFilter").mockImplementation(async (_collection, filter) => {
      const path = (filter as { must?: { match?: { value?: string } }[] }).must?.find(
        (c) => c.match?.value !== undefined,
      )?.match?.value;
      if (path === removed) throw new Error(`L2 delete failed for ${removed}`);
    });

    // A modified file keeps the run on the parallel path (a delete-only run
    // takes the fast path, which throws PartialDeletionError instead).
    await createTestFile(
      codebaseDir,
      kept,
      "export const keptNew = 2;\nconsole.log('New kept');\nconst pad = 'different padding content to trigger change detection properly now';",
    );
    await fs.rm(join(codebaseDir, removed));

    const stats = await ingest.reindexChanges(codebaseDir);

    expect(stats.filesModified).toBe(1);
    expect(stats.filesDeleted).toBe(1);
    // The modified file's own delete succeeded, so nothing was skipped.
    expect(stats.filesSkippedDueToDeleteFailure).toBeUndefined();
    expect(stats.filesFailedToDelete).toBe(1);
    expect(stats.status).toBe("partial");
  });

  it("counts removed-file and modified-file delete failures in their own counters", async () => {
    const paths = ["mod.ts", "gone.ts"];
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
    vi.spyOn(qdrant, "deletePointsByFilter").mockRejectedValue(new Error("L2 per-path failed"));

    await createTestFile(
      codebaseDir,
      "mod.ts",
      "export const modNew = 2;\nconsole.log('New mod');\nconst pad = 'different padding content to trigger change detection properly now';",
    );
    await fs.rm(join(codebaseDir, "gone.ts"));

    const stats = await ingest.reindexChanges(codebaseDir);

    expect(stats.filesSkippedDueToDeleteFailure).toBe(1);
    expect(stats.filesFailedToDelete).toBe(1);
    expect(stats.status).toBe("partial");
  });
});

describe("ReindexPipeline snapshot after a failed delete (next run retries)", () => {
  // bd tea-rags-mcp-ti1oa: a partial run used to re-stamp the snapshot from
  // the disk scan alone. A removed path whose delete failed vanished from the
  // snapshot, and a modified path whose upsert the coordinator skipped got its
  // NEW hash — so the next run saw neither as changed and the stale chunks
  // stayed in the index forever. The snapshot must describe what the index
  // actually holds for those paths.
  let ingest: IngestFacade;
  let qdrant: MockQdrantManager;
  let tempDir: string;
  let codebaseDir: string;

  const original = (name: string) =>
    `export const ${name}Original = 1;\nconsole.log('Original ${name}');\nconst pad = 'padding content to meet the chunker minimum size threshold here';`;
  const changed = (name: string) =>
    `export const ${name}New = 2;\nconsole.log('New ${name}');\nconst pad = 'different padding content to trigger change detection properly now';`;
  const filterPath = (filter: unknown) =>
    (filter as { must?: { match?: { value?: string } }[] }).must?.find((c) => c.match?.value !== undefined)?.match
      ?.value;

  /** Fail the batched + bulk delete once, and the per-path L2 delete for `failing`. */
  function failDeleteOnceFor(failing: string) {
    const spies = [
      vi.spyOn(qdrant, "deletePointsByPathsBatched").mockRejectedValueOnce(new Error("batched failed")),
      vi.spyOn(qdrant, "deletePointsByPaths").mockRejectedValueOnce(new Error("bulk failed")),
      vi.spyOn(qdrant, "deletePointsByFilter").mockImplementation(async (_collection, filter) => {
        if (filterPath(filter) === failing) throw new Error(`L2 delete failed for ${failing}`);
      }),
    ];
    return () => {
      for (const spy of spies) spy.mockRestore();
    };
  }

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager();
    ingest = new IngestFacade({
      qdrant: qdrant as any,
      embeddings: new MockEmbeddingProvider(),
      config: defaultTestConfig(),
      trajectoryConfig: defaultTrajectoryConfig(),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("re-detects a removed file whose delete failed, and deletes it on the next run", async () => {
    for (const p of ["kept", "removed"]) await createTestFile(codebaseDir, `${p}.ts`, original(p));
    await ingest.indexCodebase(codebaseDir);

    const restore = failDeleteOnceFor("removed.ts");
    await createTestFile(codebaseDir, "kept.ts", changed("kept"));
    await fs.rm(join(codebaseDir, "removed.ts"));
    const first = await ingest.reindexChanges(codebaseDir);
    expect(first.filesFailedToDelete).toBe(1);
    expect(first.status).toBe("partial");
    restore();

    const batched = vi.spyOn(qdrant, "deletePointsByPathsBatched");
    const second = await ingest.reindexChanges(codebaseDir);

    expect(second.filesDeleted).toBe(1);
    expect(second.status).toBe("completed");
    expect(batched.mock.calls.flatMap((call) => call[1])).toContain("removed.ts");
  });

  it("re-detects a modified file whose upsert was skipped, and re-ingests it on the next run", async () => {
    for (const p of ["mod", "other"]) await createTestFile(codebaseDir, `${p}.ts`, original(p));
    await ingest.indexCodebase(codebaseDir);

    const restore = failDeleteOnceFor("mod.ts");
    await createTestFile(codebaseDir, "mod.ts", changed("mod"));
    await createTestFile(codebaseDir, "other.ts", changed("other"));
    const first = await ingest.reindexChanges(codebaseDir);
    expect(first.filesSkippedDueToDeleteFailure).toBe(1);
    expect(first.status).toBe("partial");
    restore();

    const second = await ingest.reindexChanges(codebaseDir);

    expect(second.filesModified).toBe(1);
    expect(second.chunksAdded).toBeGreaterThan(0);
    expect(second.status).toBe("completed");
    expect(second.filesSkippedDueToDeleteFailure).toBeUndefined();
  });

  it("does not re-stamp the snapshot when the deletion-only fast path fails", async () => {
    // The fast path throws PartialDeletionError before closing the run, so the
    // snapshot still lists the removed file and the next run retries it.
    for (const p of ["kept", "removed"]) await createTestFile(codebaseDir, `${p}.ts`, original(p));
    await ingest.indexCodebase(codebaseDir);

    const restore = failDeleteOnceFor("removed.ts");
    await fs.rm(join(codebaseDir, "removed.ts"));
    await expect(ingest.reindexChanges(codebaseDir)).rejects.toThrow();
    restore();

    const second = await ingest.reindexChanges(codebaseDir);
    expect(second.filesDeleted).toBe(1);
    expect(second.status).toBe("completed");
  });
});
