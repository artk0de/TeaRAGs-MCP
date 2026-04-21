/**
 * SymbolSearchStrategy — behavioral tests for find_symbol extraction.
 *
 * The strategy scrolls chunks by symbolId (primary) and parentSymbolId
 * (members), deduplicates by id, and resolves via resolveSymbols().
 * Filter building lives here (not in the facade).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";

describe("SymbolSearchStrategy", () => {
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

  const buildRegistry = (mergedFilter: Record<string, unknown> | undefined = undefined) =>
    ({
      buildMergedFilter: vi.fn().mockReturnValue(mergedFilter),
    }) as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scrolls primary symbolId filter + parallel parentSymbolId filter", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
      symbol: "Reranker",
    });

    await strategy.execute({ collectionName: "c", limit: 50 });

    expect(mockScrollFiltered).toHaveBeenCalledTimes(2);
    expect(mockScrollFiltered).toHaveBeenNthCalledWith(
      1,
      "c",
      expect.objectContaining({ must: expect.arrayContaining([{ key: "symbolId", match: { text: "Reranker" } }]) }),
      200,
    );
    expect(mockScrollFiltered).toHaveBeenNthCalledWith(
      2,
      "c",
      expect.objectContaining({
        must: expect.arrayContaining([{ key: "parentSymbolId", match: { text: "Reranker" } }]),
      }),
      200,
    );
  });

  it("includes language condition in both scroll filters when provided", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
      symbol: "validate",
      language: "typescript",
    });

    await strategy.execute({ collectionName: "c", limit: 50 });

    const primaryCall = mockScrollFiltered.mock.calls[0][1];
    const parentCall = mockScrollFiltered.mock.calls[1][1];
    expect(primaryCall.must).toEqual(
      expect.arrayContaining([
        { key: "symbolId", match: { text: "validate" } },
        { key: "language", match: { value: "typescript" } },
      ]),
    );
    expect(parentCall.must).toEqual(
      expect.arrayContaining([
        { key: "parentSymbolId", match: { text: "validate" } },
        { key: "language", match: { value: "typescript" } },
      ]),
    );
  });

  it("merges pathPattern filter into both scrolls via registry", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const pathMust = [{ key: "relativePath", match: { text: "tests/" } }];
    const registry = buildRegistry({ must: pathMust });
    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], registry, {
      symbol: "Reranker",
      pathPattern: "**/tests/**",
    });

    await strategy.execute({ collectionName: "c", limit: 50 });

    expect(registry.buildMergedFilter).toHaveBeenCalled();
    const primary = mockScrollFiltered.mock.calls[0][1];
    const parent = mockScrollFiltered.mock.calls[1][1];
    expect(primary.must).toEqual(
      expect.arrayContaining([{ key: "symbolId", match: { text: "Reranker" } }, ...pathMust]),
    );
    expect(parent.must).toEqual(
      expect.arrayContaining([{ key: "parentSymbolId", match: { text: "Reranker" } }, ...pathMust]),
    );
  });

  it("propagates must_not from registry into both scroll filters (negation)", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const mustNot = [{ key: "relativePath", match: { text: "ingest/" } }];
    const registry = buildRegistry({ must_not: mustNot });
    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], registry, {
      symbol: "Pipeline",
      pathPattern: "!**/ingest/**",
    });

    await strategy.execute({ collectionName: "c", limit: 50 });

    expect(mockScrollFiltered.mock.calls[0][1].must_not).toEqual(mustNot);
    expect(mockScrollFiltered.mock.calls[1][1].must_not).toEqual(mustNot);
  });

  it("deduplicates chunks by id across the two scrolls", async () => {
    // Same chunk appears in both primary and parent scrolls — must appear once
    const shared = {
      id: "shared-id",
      payload: {
        symbolId: "Foo#bar",
        parentSymbolId: "Foo",
        chunkType: "function",
        relativePath: "src/foo.ts",
        content: "",
        startLine: 1,
        endLine: 5,
      },
    };
    mockScrollFiltered.mockResolvedValueOnce([shared]).mockResolvedValueOnce([shared]);

    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "Foo" });
    const result = await strategy.execute({ collectionName: "c", limit: 50 });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("shared-id");
  });

  it("applies pagination (offset then limit)", async () => {
    const makeChunk = (i: number) => ({
      id: `id-${i}`,
      payload: {
        symbolId: `Foo#m${i}`,
        chunkType: "function",
        relativePath: "src/foo.ts",
        content: "",
        startLine: i,
        endLine: i + 1,
      },
    });
    mockScrollFiltered
      .mockResolvedValueOnce([makeChunk(1), makeChunk(2), makeChunk(3), makeChunk(4)])
      .mockResolvedValueOnce([]);

    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "Foo" });
    const result = await strategy.execute({ collectionName: "c", limit: 2, offset: 1 });

    expect(result.map((r) => r.id)).toEqual(["id-2", "id-3"]);
  });

  it("returns empty when no scroll results", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "nope" });

    const result = await strategy.execute({ collectionName: "c", limit: 50 });

    expect(result).toEqual([]);
  });

  it("applies reranker when rerank option is set in context", async () => {
    mockScrollFiltered
      .mockResolvedValueOnce([
        {
          id: "a",
          payload: {
            symbolId: "Foo",
            chunkType: "function",
            relativePath: "src/a.ts",
            content: "",
            startLine: 1,
            endLine: 2,
          },
        },
      ])
      .mockResolvedValueOnce([]);
    mockRerank.mockImplementation((results: any[]) => results.map((r) => ({ ...r, score: 42 })));

    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "Foo" });
    const result = await strategy.execute({ collectionName: "c", limit: 50, rerank: "techDebt" });

    expect(mockRerank).toHaveBeenCalled();
    expect(result[0].score).toBe(42);
  });
});
