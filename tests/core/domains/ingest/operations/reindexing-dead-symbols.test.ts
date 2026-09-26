/**
 * Which paths an incremental reindex hands to the providers' deletion hook
 * (epic tea-rags-mcp-4p3sb — the ingest half of the dead-symbol matrix).
 *
 * Invariant: no row outlives its source. The codegraph side
 * (`provider-dead-symbols.test.ts`) proves `handleDeletedPaths` leaves no row
 * for a path it is given, and that a re-walk retires what a CHANGED file lost.
 * Neither helps if a gone path never reaches the hook, or if a changed path is
 * sent there by mistake. So this pins the routing in `ReindexPipeline`:
 *
 * | change                        | `notifyDeletions` gets | how the graph heals              |
 * | ----------------------------- | ---------------------- | -------------------------------- |
 * | file deleted                  | the path               | `handleDeletedPaths`             |
 * | file renamed / moved          | the OLD path only      | old: hook, new: walked as added  |
 * | file newly `.contextignore`d  | the path               | `handleDeletedPaths`             |
 * | file modified                 | nothing                | re-walk (row diff)               |
 * | file unchanged                | nothing                | untouched                        |
 *
 * A modified file must stay OUT of the hook: routing it there would race the
 * walker re-writing the same file (the `providerDeletedOnly` split). Excluding
 * a file from the GRAPH only (codegraph exclusion config) is not an ingest
 * change at all — the repair pass orphans it (case 7 of the provider matrix).
 *
 * Bug history: bd tea-rags-mcp-dy852 (3e24ffa0a) — the deletion hook is also
 * where the derived tables are pruned; bd tea-rags-mcp-dvzdm (b53f5faf4).
 */
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
import { EnrichmentCoordinator } from "../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";

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

describe("ReindexPipeline — which paths reach the provider deletion hook", () => {
  let ingest: IngestFacade;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    ingest = new IngestFacade({
      qdrant: new MockQdrantManager() as never,
      embeddings: new MockEmbeddingProvider(),
      config: defaultTestConfig(),
      trajectoryConfig: defaultTrajectoryConfig(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  /**
   * Index `files`, apply `change`, reindex, and return the distinct paths handed
   * to `notifyDeletions`. Distinct, because a newly ignored file is listed in
   * both `deleted` and `newlyIgnored` and arrives twice — harmless, the hook is
   * idempotent (`CodegraphEnrichmentProvider#handleDeletedPaths`).
   */
  async function notifiedAfter(files: Record<string, string>, change: () => Promise<void>): Promise<string[]> {
    for (const [rel, src] of Object.entries(files)) await createTestFile(codebaseDir, rel, src);
    await ingest.indexCodebase(codebaseDir);
    const notify = vi.spyOn(EnrichmentCoordinator.prototype, "notifyDeletions");
    await change();
    await ingest.reindexChanges(codebaseDir);
    return [...new Set(notify.mock.calls.flatMap(([paths]) => paths))].sort();
  }

  const KEEP = { "keep.ts": "export const keep = 1;\nconsole.log('keep');" };
  const GONE = { "gone.ts": "export const gone = 2;\nconsole.log('gone');" };

  it("a deleted file reaches the hook", async () => {
    const notified = await notifiedAfter({ ...KEEP, ...GONE }, async () => fs.unlink(join(codebaseDir, "gone.ts")));
    expect(notified).toEqual(["gone.ts"]);
  });

  it("a renamed file reaches the hook under its OLD path only; the new path is walked as added", async () => {
    const notified = await notifiedAfter({ ...KEEP, ...GONE }, async () =>
      fs.rename(join(codebaseDir, "gone.ts"), join(codebaseDir, "moved.ts")),
    );
    expect(notified).toEqual(["gone.ts"]);
  });

  it("a file newly listed in .contextignore reaches the hook, as if deleted", async () => {
    const notified = await notifiedAfter({ ...KEEP, ...GONE }, async () =>
      fs.writeFile(join(codebaseDir, ".contextignore"), "gone.ts\n"),
    );
    expect(notified).toEqual(["gone.ts"]);
  });

  it("a modified file never reaches the hook — its re-walk retires what it lost", async () => {
    const notified = await notifiedAfter({ ...KEEP, ...GONE }, async () =>
      fs.writeFile(join(codebaseDir, "gone.ts"), "export const gone = 3;\nconsole.log('edited');"),
    );
    expect(notified).toEqual([]);
  });

  it("an unchanged file never reaches the hook", async () => {
    const notified = await notifiedAfter({ ...KEEP, ...GONE }, async () => fs.unlink(join(codebaseDir, "gone.ts")));
    expect(notified).not.toContain("keep.ts");
  });
});
