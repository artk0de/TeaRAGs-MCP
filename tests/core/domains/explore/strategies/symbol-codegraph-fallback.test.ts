import { describe, expect, it, vi } from "vitest";

import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";

function makeStrategy(opts: {
  scroll: unknown[];
  resolver?: { resolveSymbolChunk: ReturnType<typeof vi.fn> };
  getPoint?: ReturnType<typeof vi.fn>;
}) {
  const qdrant = {
    scrollFiltered: vi.fn().mockResolvedValue(opts.scroll),
    getPoint: opts.getPoint ?? vi.fn(),
  };
  const reranker = {} as never;
  const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) };
  return new SymbolSearchStrategy(
    qdrant as never,
    reranker,
    [],
    [],
    registry as never,
    { symbol: "Foo#bar" },
    opts.resolver as never, // optional codegraph reader
  );
}

const runExplore = async (strat: unknown, ctx: unknown) =>
  (strat as { executeExplore: (c: unknown) => Promise<unknown[]> }).executeExplore(ctx);

const ctx = { collectionName: "col", limit: 10, metaOnly: false } as never;

describe("SymbolSearchStrategy — codegraph fallback", () => {
  it("falls back to the covering chunk when the Qdrant scroll is empty", async () => {
    const getPoint = vi.fn().mockResolvedValue({
      id: "uuid-1",
      payload: {
        symbolId: "Foo",
        chunkType: "class",
        relativePath: "foo.rb",
        content: "class Foo; def bar; end; end",
        startLine: 1,
        endLine: 3,
      },
    });
    const resolver = {
      resolveSymbolChunk: vi.fn().mockResolvedValue({ relPath: "foo.rb", chunkId: "chunk_cls" }),
    };
    const strat = makeStrategy({ scroll: [], resolver, getPoint });

    const results = await runExplore(strat, ctx);

    expect(resolver.resolveSymbolChunk).toHaveBeenCalledWith("col", "Foo#bar");
    expect(getPoint).toHaveBeenCalledWith("col", "chunk_cls");
    expect(results).toHaveLength(1);
    // The fallback returns the covering chunk fetched via getPoint.
    expect((results[0] as { id: string }).id).toBe("uuid-1");
  });

  it("strips content from the fallback chunk when metaOnly is set", async () => {
    const getPoint = vi.fn().mockResolvedValue({
      id: "uuid-1",
      payload: { symbolId: "Foo", chunkType: "class", relativePath: "foo.rb", content: "class Foo; end" },
    });
    const resolver = {
      resolveSymbolChunk: vi.fn().mockResolvedValue({ relPath: "foo.rb", chunkId: "chunk_cls" }),
    };
    const strat = makeStrategy({ scroll: [], resolver, getPoint });

    const results = await runExplore(strat, { collectionName: "col", limit: 10, metaOnly: true });

    expect(results).toHaveLength(1);
    expect((results[0] as { payload: { content?: unknown } }).payload.content).toBeUndefined();
  });

  it("does NOT consult the resolver when the primary scroll already matched", async () => {
    const resolver = { resolveSymbolChunk: vi.fn() };
    const strat = makeStrategy({
      scroll: [
        {
          id: "c1",
          payload: {
            symbolId: "Foo#bar",
            chunkType: "function",
            relativePath: "foo.rb",
            content: "def bar; end",
            startLine: 5,
            endLine: 6,
          },
        },
      ],
      resolver,
    });
    await runExplore(strat, ctx);
    expect(resolver.resolveSymbolChunk).not.toHaveBeenCalled();
  });

  it("is a graceful no-op when no resolver is injected (codegraph disabled)", async () => {
    const strat = makeStrategy({ scroll: [] });
    const results = await runExplore(strat, ctx);
    expect(results).toEqual([]);
  });

  it("is a no-op when the resolver returns null (symbol absent / chunk_id null)", async () => {
    const resolver = { resolveSymbolChunk: vi.fn().mockResolvedValue(null) };
    const getPoint = vi.fn();
    const strat = makeStrategy({ scroll: [], resolver, getPoint });
    const results = await runExplore(strat, ctx);
    expect(getPoint).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});
