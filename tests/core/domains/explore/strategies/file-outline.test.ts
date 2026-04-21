/**
 * FileOutlineStrategy — behavioral tests for find_symbol relativePath-mode
 * extraction. Scrolls by relativePath, groups via CodeChunkGrouper
 * (code files) or DocChunkGrouper (markdown/docs).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FileOutlineStrategy } from "../../../../../src/core/domains/explore/strategies/file-outline.js";

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

    expect(mockScrollFiltered).toHaveBeenCalledWith(
      "c",
      { must: [{ key: "relativePath", match: { text: "src/utils.ts" } }] },
      200,
    );
  });

  it("adds language condition when provided", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], {
      relativePath: "src/utils.ts",
      language: "typescript",
    });

    await strategy.execute({ collectionName: "c", limit: 1 });

    expect(mockScrollFiltered.mock.calls[0][1].must).toEqual([
      { key: "relativePath", match: { text: "src/utils.ts" } },
      { key: "language", match: { value: "typescript" } },
    ]);
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
