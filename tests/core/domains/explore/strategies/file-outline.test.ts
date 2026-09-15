/**
 * FileOutlineStrategy — behavioral tests for find_symbol relativePath-mode
 * extraction. Scrolls by relativePath, groups via CodeChunkGrouper
 * (code files) or DocChunkGrouper (markdown/docs).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  INDEX_FRESHNESS_PATH,
  INDEX_FRESHNESS_TOC,
  indexFreshnessChunks,
  SEARCH_CASCADE_PATH,
  SEARCH_CASCADE_TOC,
  searchCascadeChunks,
} from "../__fixtures__/doc-toc-chunks.js";
import { FileOutlineStrategy } from "../../../../../src/core/domains/explore/strategies/file-outline.js";

/**
 * bd tea-rags-mcp-ivp12 — the path condition was a lone `match: { value }` on a
 * TEXT-indexed key, so every outline request scanned the collection (677–1002 ms
 * on the live self-index). Exactness is unchanged; the indexed text condition in
 * front of it is what the planner can actually use.
 */
const exactPath = (path: string) => [
  { key: "relativePath", match: { text: path } },
  { key: "relativePath", match: { value: path } },
];

describe("FileOutlineStrategy", () => {
  const mockScrollFiltered = vi.fn();
  const mockRerank = vi.fn((r: any[]) => r);

  const qdrant = { scrollFiltered: mockScrollFiltered } as any;
  const reranker = {
    rerank: mockRerank,
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getDescriptors: vi.fn().mockReturnValue([]),
    getFullPreset: vi.fn().mockReturnValue(undefined),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scrolls by relativePath filter at a fixed page size", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], {
      relativePath: "src/utils.ts",
    });

    await strategy.execute({ collectionName: "c", limit: 1 });

    expect(mockScrollFiltered).toHaveBeenCalledWith("c", { must: exactPath("src/utils.ts") }, 200);
  });

  it("adds language condition when provided", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], {
      relativePath: "src/utils.ts",
      language: "typescript",
    });

    await strategy.execute({ collectionName: "c", limit: 1 });

    expect(mockScrollFiltered.mock.calls[0][1].must).toEqual([
      ...exactPath("src/utils.ts"),
      { key: "language", match: { value: "typescript" } },
    ]);
  });

  /**
   * bd tea-rags-mcp-znxg8 — the path mode used `match: { text }`, Qdrant's
   * full-text predicate over the "word"-tokenized `relativePath` index. Full
   * text matches when the query's tokens are a SUBSET of the field's, so
   * "app/services/workflow/tasks/update.rb"
   * {app,services,workflow,tasks,update,rb} matched
   * "app/services/workflow/async_operations/notify/tasks/batch_update.rb"
   * {app,services,workflow,async,operations,notify,tasks,batch,update,rb} — the
   * underscore in `batch_update` is a token boundary. `CodeChunkGrouper.groupFile`
   * then labels the merged outline with the FIRST chunk's path, so the caller
   * got another file's outline with no signal it was the wrong file.
   */
  describe("exact path addressing (bd tea-rags-mcp-znxg8)", () => {
    const REQUESTED = "app/services/workflow/tasks/update.rb";
    const SUPERSET = "app/services/workflow/async_operations/notify/tasks/batch_update.rb";

    const chunk = (id: string, relativePath: string, name: string) => ({
      id,
      payload: {
        symbolId: name,
        chunkType: "function",
        relativePath,
        content: `def ${name}; end`,
        startLine: 1,
        endLine: 5,
        language: "ruby",
        name,
      },
    });

    it("filters on an exact value match, so a token-superset path cannot satisfy it", async () => {
      mockScrollFiltered.mockResolvedValue([]);
      const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], { relativePath: REQUESTED });

      await strategy.execute({ collectionName: "c", limit: 1 });

      expect(mockScrollFiltered.mock.calls[0][1].must).toEqual(exactPath(REQUESTED));
    });

    it("never blends a token-superset path into the requested file's outline", async () => {
      mockScrollFiltered.mockResolvedValue([chunk("s1", SUPERSET, "batch_perform"), chunk("r1", REQUESTED, "perform")]);
      const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], { relativePath: REQUESTED });

      const result = await strategy.execute({ collectionName: "c", limit: 1 });

      expect(result.every((r) => r.payload?.relativePath === REQUESTED)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("batch_update.rb");
      expect(JSON.stringify(result)).not.toContain("batch_perform");
    });

    it("returns empty instead of a different file when the requested path is absent", async () => {
      mockScrollFiltered.mockResolvedValue([chunk("s1", SUPERSET, "batch_perform")]);
      const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], { relativePath: REQUESTED });

      const result = await strategy.execute({ collectionName: "c", limit: 1 });

      expect(result).toEqual([]);
    });
  });

  it("returns empty results when scroll yields no chunks", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], {
      relativePath: "src/missing.ts",
    });

    const result = await strategy.execute({ collectionName: "c", limit: 1 });

    expect(result).toEqual([]);
  });

  it("groups a code file into a single file outline via CodeChunkGrouper", async () => {
    mockScrollFiltered.mockResolvedValue([
      {
        id: "a",
        payload: {
          symbolId: "fn1",
          chunkType: "function",
          relativePath: "src/utils.ts",
          content: "fn1",
          startLine: 1,
          endLine: 5,
          language: "typescript",
          name: "fn1",
        },
      },
      {
        id: "b",
        payload: {
          symbolId: "fn2",
          chunkType: "function",
          relativePath: "src/utils.ts",
          content: "fn2",
          startLine: 10,
          endLine: 15,
          language: "typescript",
          name: "fn2",
        },
      },
    ]);
    const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], {
      relativePath: "src/utils.ts",
    });

    const result = await strategy.execute({ collectionName: "c", limit: 1 });

    expect(result).toHaveLength(1);
    expect(result[0].payload?.relativePath).toBe("src/utils.ts");
    expect(result[0].payload?.chunkCount).toBe(2);
  });

  it("groups a doc file into a TOC via DocChunkGrouper when isDocumentation chunks present", async () => {
    mockScrollFiltered.mockResolvedValue([
      {
        id: "d1",
        payload: {
          symbolId: "guide.md",
          chunkType: "block",
          relativePath: "docs/guide.md",
          content: "# Intro\n",
          startLine: 1,
          endLine: 3,
          language: "markdown",
          isDocumentation: true,
          headingPath: [{ depth: 1, text: "Intro" }],
        },
      },
      {
        id: "d2",
        payload: {
          symbolId: "guide.md#Setup",
          chunkType: "block",
          relativePath: "docs/guide.md",
          content: "## Setup\n",
          startLine: 4,
          endLine: 6,
          language: "markdown",
          isDocumentation: true,
          headingPath: [
            { depth: 1, text: "Intro" },
            { depth: 2, text: "Setup" },
          ],
        },
      },
    ]);
    const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], {
      relativePath: "docs/guide.md",
    });

    const result = await strategy.execute({ collectionName: "c", limit: 1 });

    expect(result).toHaveLength(1);
    expect(result[0].payload?.relativePath).toBe("docs/guide.md");
  });

  // tea-rags-mcp-mypsl — live: `# Search Cascade  doc:1e20e341ac6b` and
  // `## Principles  doc:1e20e341ac6b` on two lines of one TOC.
  it("renders a doc TOC whose ancestor-only heading carries no section id", async () => {
    mockScrollFiltered.mockResolvedValue(searchCascadeChunks());
    const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], { relativePath: SEARCH_CASCADE_PATH });

    const result = await strategy.execute({ collectionName: "c", limit: 1 });

    expect(result).toHaveLength(1);
    expect(result[0].payload?.content).toBe(SEARCH_CASCADE_TOC);
  });

  it("keeps the section id of a doc H1 that owns intro text", async () => {
    mockScrollFiltered.mockResolvedValue(indexFreshnessChunks());
    const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], { relativePath: INDEX_FRESHNESS_PATH });

    const result = await strategy.execute({ collectionName: "c", limit: 1 });

    expect(result[0].payload?.content).toBe(INDEX_FRESHNESS_TOC);
  });

  it("strips payload.content when metaOnly is true", async () => {
    mockScrollFiltered.mockResolvedValue([
      {
        id: "a",
        payload: {
          symbolId: "fn",
          chunkType: "function",
          relativePath: "src/x.ts",
          content: "body",
          startLine: 1,
          endLine: 5,
          language: "typescript",
          name: "fn",
        },
      },
    ]);
    const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], {
      relativePath: "src/x.ts",
    });

    const result = await strategy.execute({ collectionName: "c", limit: 1, metaOnly: true });

    expect(result[0].payload?.content).toBeUndefined();
  });

  it("invokes reranker when rerank option is set", async () => {
    mockScrollFiltered.mockResolvedValue([
      {
        id: "a",
        payload: {
          symbolId: "fn",
          chunkType: "function",
          relativePath: "src/x.ts",
          content: "body",
          startLine: 1,
          endLine: 5,
          language: "typescript",
          name: "fn",
        },
      },
    ]);
    mockRerank.mockImplementation((results: any[]) => results.map((r) => ({ ...r, score: 99 })));

    const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], {
      relativePath: "src/x.ts",
    });

    const result = await strategy.execute({ collectionName: "c", limit: 1, rerank: "techDebt" });

    expect(mockRerank).toHaveBeenCalled();
    expect(result[0].score).toBe(99);
  });
});
