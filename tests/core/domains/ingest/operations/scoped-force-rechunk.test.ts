/**
 * Scoped `--force` (bd tea-rags-mcp-j4oww): `forceReindex` plus any file filter
 * re-chunks the selected indexed files IN PLACE on the live collection — their
 * points deleted and rebuilt, every other point untouched, no new versioned
 * collection, no alias flip. A plain `forceReindex` keeps building a new one.
 */

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
import { warmChunkerPoolFactory } from "../__helpers__/warm-chunker-pool.js";
import { IngestFacade } from "../../../../../src/core/api/index.js";
import { NotIndexedError } from "../../../../../src/core/domains/ingest/errors.js";

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

const PAD = "const pad = 'padding content to meet the chunker minimum size threshold for the fallback';";

describe("scoped force re-chunk", () => {
  let ingest: IngestFacade;
  let qdrant: MockQdrantManager;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager();
    ingest = new IngestFacade({
      qdrant: qdrant as any,
      embeddings: new MockEmbeddingProvider(),
      config: defaultTestConfig(),
      trajectoryConfig: defaultTrajectoryConfig(),
      createChunkerPool: warmChunkerPoolFactory,
    });
    await createTestFile(codebaseDir, "src/app.ts", `export const app = 1;\n${PAD}`);
    await createTestFile(codebaseDir, "src/app.test.ts", `export const appTest = 1;\n${PAD}`);
    await createTestFile(codebaseDir, "tests/util.test.ts", `export const util = 1;\n${PAD}`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  async function pointsByPath(): Promise<Map<string, (string | number)[]>> {
    const status = await ingest.getIndexStatus(codebaseDir);
    const points = await qdrant.scrollFiltered(status.collectionName!, {}, 10_000);
    const byPath = new Map<string, (string | number)[]>();
    for (const point of points) {
      const path = point.payload.relativePath as string | undefined;
      if (!path) continue;
      byPath.set(path, [...(byPath.get(path) ?? []), point.id]);
    }
    return byPath;
  }

  it("re-chunks only the selected files and leaves every other point untouched", async () => {
    await ingest.indexCodebase(codebaseDir);
    const before = await pointsByPath();
    const deleteSpy = vi.spyOn(qdrant, "deletePointsByPathsBatched");

    const stats = await ingest.indexCodebase(codebaseDir, { forceReindex: true, testFile: "only" });

    expect(stats.status).toBe("completed");
    expect(stats.changeDetails?.filesRechunked).toBe(2);
    const deleted = deleteSpy.mock.calls.flatMap((call) => call[1]);
    expect([...deleted].sort()).toEqual(["src/app.test.ts", "tests/util.test.ts"]);
    const after = await pointsByPath();
    expect(after.get("src/app.ts")).toEqual(before.get("src/app.ts"));
    expect(after.get("src/app.test.ts")?.length).toBeGreaterThan(0);
    expect(after.get("tests/util.test.ts")?.length).toBeGreaterThan(0);
  });

  it("builds no new collection and moves no alias", async () => {
    await ingest.indexCodebase(codebaseDir);
    const collectionsBefore = await qdrant.listCollections();
    const aliasesBefore = await qdrant.aliases.listAliases();

    await ingest.indexCodebase(codebaseDir, { forceReindex: true, languages: ["typescript"], pathPattern: "tests/**" });

    expect(await qdrant.listCollections()).toEqual(collectionsBefore);
    expect(await qdrant.aliases.listAliases()).toEqual(aliasesBefore);
  });

  it("refuses to run on a project that has no index", async () => {
    await expect(ingest.indexCodebase(codebaseDir, { forceReindex: true, testFile: "only" })).rejects.toBeInstanceOf(
      NotIndexedError,
    );
  });

  it("a run that dies after selecting its files leaves them for the next plain incremental to re-chunk", async () => {
    await ingest.indexCodebase(codebaseDir);
    vi.spyOn(qdrant, "pauseOptimizer").mockRejectedValueOnce(new Error("killed mid-run"));

    await expect(
      ingest.indexCodebase(codebaseDir, { forceReindex: true, files: ["src/app.test.ts"] }),
    ).rejects.toThrow();

    const deleteSpy = vi.spyOn(qdrant, "deletePointsByPathsBatched");
    const stats = await ingest.indexCodebase(codebaseDir);

    expect(stats.changeDetails?.filesModified).toBe(1);
    expect(deleteSpy.mock.calls.flatMap((call) => call[1])).toEqual(["src/app.test.ts"]);
  });

  it("an empty selection still completes as a plain incremental", async () => {
    await ingest.indexCodebase(codebaseDir);

    const stats = await ingest.indexCodebase(codebaseDir, { forceReindex: true, pathPattern: "nothing/**" });

    expect(stats.status).toBe("completed");
    expect(stats.changeDetails?.filesRechunked).toBe(0);
  });
});
