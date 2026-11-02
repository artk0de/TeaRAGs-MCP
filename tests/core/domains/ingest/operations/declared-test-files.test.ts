/**
 * Declared test files (bd tea-rags-mcp-52wk3.10): a file another file declares
 * test code (`#[cfg(test)] mod testutil;`) is classified as a test on a full
 * index, and an incremental run where ONLY the declaring file changes flips
 * the declared file — re-chunked, `isTest` set or cleared — although its own
 * content never moved.
 */

import { readFile } from "node:fs/promises";
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
import { warmChunkerPoolFactory } from "../__helpers__/warm-chunker-pool.js";
import { IngestFacade } from "../../../../../src/core/api/index.js";
import type { DeclaredTestFileFinder } from "../../../../../src/core/contracts/types/language.js";

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
const DECLARING = `#[cfg(test)]\nmod testutil;\n${PAD}`;
const NOT_DECLARING = `mod other;\n${PAD}`;

/** The language side stubbed: `src/lib.ts` declaring `mod testutil;` makes `src/testutil.ts` test code. */
const declaredTestFileFinder: DeclaredTestFileFinder = async (projectRoot, relativePaths) => {
  if (!relativePaths.includes("src/lib.ts")) return new Set();
  const source = await readFile(join(projectRoot, "src/lib.ts"), "utf-8");
  return new Set(source.includes("mod testutil;") ? ["src/testutil.ts"] : []);
};

describe("declared test files through the ingest pipeline", () => {
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
      blobReaderFactory: async () => {
        throw new Error("blob reads are not expected with enrichment off");
      },
      trajectoryConfig: defaultTrajectoryConfig(),
      createChunkerPool: warmChunkerPoolFactory,
      declaredTestFileFinder,
    });
    await createTestFile(codebaseDir, "src/lib.ts", DECLARING);
    await createTestFile(codebaseDir, "src/testutil.ts", `export const helper = 1;\n${PAD}`);
    await createTestFile(codebaseDir, "src/parser.ts", `export const parser = 1;\n${PAD}`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  async function isTestByPath(): Promise<Map<string, boolean[]>> {
    const status = await ingest.getIndexStatus(codebaseDir);
    const points = await qdrant.scrollFiltered(status.collectionName!, {}, 10_000);
    const byPath = new Map<string, boolean[]>();
    for (const point of points) {
      const path = point.payload.relativePath as string | undefined;
      if (!path) continue;
      byPath.set(path, [...(byPath.get(path) ?? []), point.payload.isTest === true]);
    }
    return byPath;
  }

  it("marks the declared file's chunks isTest on a full index, and only those", async () => {
    await ingest.indexCodebase(codebaseDir);

    const byPath = await isTestByPath();
    expect(byPath.get("src/testutil.ts")?.length).toBeGreaterThan(0);
    expect(byPath.get("src/testutil.ts")?.every(Boolean)).toBe(true);
    expect(byPath.get("src/parser.ts")?.some(Boolean)).toBe(false);
    expect(byPath.get("src/lib.ts")?.some(Boolean)).toBe(false);
  });

  it("flips the declared file when only the declaring file changes, both ways", async () => {
    await ingest.indexCodebase(codebaseDir);
    const deleteSpy = vi.spyOn(qdrant, "deletePointsByPathsBatched");

    await createTestFile(codebaseDir, "src/lib.ts", NOT_DECLARING);
    await ingest.indexCodebase(codebaseDir);

    const reChunked = deleteSpy.mock.calls.flatMap((call) => call[1]);
    expect([...new Set(reChunked)].sort()).toEqual(["src/lib.ts", "src/testutil.ts"]);
    let byPath = await isTestByPath();
    expect(byPath.get("src/testutil.ts")?.length).toBeGreaterThan(0);
    expect(byPath.get("src/testutil.ts")?.some(Boolean)).toBe(false);

    deleteSpy.mockClear();
    await createTestFile(codebaseDir, "src/lib.ts", DECLARING);
    await ingest.indexCodebase(codebaseDir);

    expect([...new Set(deleteSpy.mock.calls.flatMap((call) => call[1]))].sort()).toEqual([
      "src/lib.ts",
      "src/testutil.ts",
    ]);
    byPath = await isTestByPath();
    expect(byPath.get("src/testutil.ts")?.every(Boolean)).toBe(true);
  });

  it("keeps two projects indexed in one process apart, sequentially and interleaved", async () => {
    const other = await createTempTestDir();
    try {
      // Project B holds the same relative path, but nothing in B declares it.
      await createTestFile(other.codebaseDir, "src/lib.ts", NOT_DECLARING);
      await createTestFile(other.codebaseDir, "src/testutil.ts", `export const helperB = 1;\n${PAD}`);

      await Promise.all([ingest.indexCodebase(codebaseDir), ingest.indexCodebase(other.codebaseDir)]);

      const status = await ingest.getIndexStatus(other.codebaseDir);
      const otherPoints = await qdrant.scrollFiltered(status.collectionName!, {}, 10_000);
      const otherTestutil = otherPoints.filter((point) => point.payload.relativePath === "src/testutil.ts");
      expect(otherTestutil.length).toBeGreaterThan(0);
      expect(otherTestutil.some((point) => point.payload.isTest === true)).toBe(false);
      expect((await isTestByPath()).get("src/testutil.ts")?.every(Boolean)).toBe(true);

      // A later run of B alone must not clear A's set either.
      await createTestFile(other.codebaseDir, "src/parser.ts", `export const parserB = 1;\n${PAD}`);
      await ingest.indexCodebase(other.codebaseDir);
      await createTestFile(codebaseDir, "src/parser.ts", `export const parserChanged = 2;\n${PAD}`);
      await ingest.indexCodebase(codebaseDir);
      expect((await isTestByPath()).get("src/testutil.ts")?.every(Boolean)).toBe(true);
    } finally {
      await cleanupTempDir(other.tempDir);
    }
  });

  it("re-chunks nothing extra when the declared set did not move", async () => {
    await ingest.indexCodebase(codebaseDir);
    const deleteSpy = vi.spyOn(qdrant, "deletePointsByPathsBatched");

    await createTestFile(codebaseDir, "src/parser.ts", `export const parserChanged = 2;\n${PAD}`);
    await ingest.indexCodebase(codebaseDir);

    expect([...new Set(deleteSpy.mock.calls.flatMap((call) => call[1]))]).toEqual(["src/parser.ts"]);
    expect((await isTestByPath()).get("src/testutil.ts")?.every(Boolean)).toBe(true);
  });
});
