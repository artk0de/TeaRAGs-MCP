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

/** `beginRun`'s trailing positional parameter: what part of the corpus the run resolves. */
const RUN_COVERAGE_ARG = 9;

// bd tea-rags-mcp-xpmwg — the pipeline that opens a run is what knows whether it
// covers the whole corpus. A full index scans every file; an incremental
// reindex walks only what changed, and must never claim otherwise, or codegraph
// reports a batch-sized resolve breakdown as the corpus.
describe("Indexing pipelines — enrichment run coverage (xpmwg)", () => {
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

  it("a full index opens a whole-corpus run", async () => {
    await createTestFile(codebaseDir, "a.ts", "export const a = 1;");
    const beginRunSpy = vi.spyOn(EnrichmentCoordinator.prototype, "beginRun");

    await ingest.indexCodebase(codebaseDir);

    const coverages = beginRunSpy.mock.calls.map((c) => c[RUN_COVERAGE_ARG]);
    expect(coverages.length).toBeGreaterThan(0);
    expect(coverages.every((c) => c === "wholeCorpus")).toBe(true);
  });

  it("an incremental reindex never opens a whole-corpus run", async () => {
    await createTestFile(codebaseDir, "a.ts", "export const a = 1;");
    await ingest.indexCodebase(codebaseDir);
    const beginRunSpy = vi.spyOn(EnrichmentCoordinator.prototype, "beginRun");

    await createTestFile(codebaseDir, "b.ts", "export const b = 2;");
    await ingest.reindexChanges(codebaseDir);

    const coverages = beginRunSpy.mock.calls.map((c) => c[RUN_COVERAGE_ARG]);
    expect(coverages.length).toBeGreaterThan(0);
    expect(coverages.some((c) => c === "wholeCorpus")).toBe(false);
  });
});
