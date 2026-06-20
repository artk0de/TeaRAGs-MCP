import { describe, expect, it, vi } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../../src/core/contracts/types/trajectory.js";
import { BaseExploreStrategy } from "../../../../../src/core/domains/explore/strategies/base.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";
import type { ExploreContext, ExploreResult } from "../../../../../src/core/domains/explore/strategies/types.js";

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
    opts.resolver as never, // new optional last param
  );
}

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

    const results = await (strat as never as { executeExplore: (c: unknown) => Promise<unknown[]> }).executeExplore(
      ctx,
    );

    expect(resolver.resolveSymbolChunk).toHaveBeenCalledWith("col", "Foo#bar");
    expect(getPoint).toHaveBeenCalledWith("col", "chunk_cls");
    expect(results).toHaveLength(1);
    expect((results[0] as { fromCodegraphFallback?: boolean }).fromCodegraphFallback).toBe(true);
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
    await (strat as never as { executeExplore: (c: unknown) => Promise<unknown[]> }).executeExplore(ctx);
    expect(resolver.resolveSymbolChunk).not.toHaveBeenCalled();
  });

  it("is a graceful no-op when no resolver is injected (codegraph disabled)", async () => {
    const strat = makeStrategy({ scroll: [] });
    const results = await (strat as never as { executeExplore: (c: unknown) => Promise<unknown[]> }).executeExplore(
      ctx,
    );
    expect(results).toEqual([]);
  });

  it("is a no-op when the resolver returns null (symbol absent / chunk_id null)", async () => {
    const resolver = { resolveSymbolChunk: vi.fn().mockResolvedValue(null) };
    const getPoint = vi.fn();
    const strat = makeStrategy({ scroll: [], resolver, getPoint });
    const results = await (strat as never as { executeExplore: (c: unknown) => Promise<unknown[]> }).executeExplore(
      ctx,
    );
    expect(getPoint).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyMetaOnly — fromCodegraphFallback preservation (0rskm)
// ---------------------------------------------------------------------------
//
// BaseExploreStrategy#applyMetaOnly reconstructs each ExploreResult from
// scratch: `{ id, score, payload }`. The `fromCodegraphFallback` flag that
// resolveViaCodegraph sets on the top-level result object is silently
// dropped. This suite exercises applyMetaOnly via execute() on a minimal
// BaseExploreStrategy subclass that returns a codegraph-fallback result.
// SymbolSearchStrategy is tested above (it overrides postProcess entirely);
// this suite targets the BASE postProcess → applyMetaOnly path that any
// other strategy extending BaseExploreStrategy would hit.

class FallbackTestStrategy extends BaseExploreStrategy {
  readonly type = "vector" as const;
  private readonly rawResults: ExploreResult[];

  constructor(results: ExploreResult[], payloadSignals: PayloadSignalDescriptor[] = []) {
    super(
      {} as never, // qdrant — not used by this strategy
      { rerank: vi.fn((r: ExploreResult[]) => r) } as never, // reranker
      payloadSignals,
      [], // essentialKeys
    );
    this.rawResults = results;
  }

  protected async executeExplore(_ctx: ExploreContext): Promise<ExploreResult[]> {
    return this.rawResults;
  }
}

describe("BaseExploreStrategy#applyMetaOnly — fromCodegraphFallback preservation (0rskm)", () => {
  it("preserves fromCodegraphFallback flag on results that pass through applyMetaOnly", async () => {
    const payloadSignals: PayloadSignalDescriptor[] = [
      { key: "relativePath", type: "string", description: "File path" },
    ];
    const fallbackResult: ExploreResult = {
      id: "chunk-cls",
      score: 1,
      payload: { relativePath: "foo.rb", content: "class Foo; end" },
      fromCodegraphFallback: true,
    };
    const strategy = new FallbackTestStrategy([fallbackResult], payloadSignals);

    const results = await strategy.execute({
      collectionName: "col",
      limit: 10,
      metaOnly: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].fromCodegraphFallback).toBe(true);
  });

  it("does NOT attach fromCodegraphFallback on normal results (flag absent by default)", async () => {
    const payloadSignals: PayloadSignalDescriptor[] = [
      { key: "relativePath", type: "string", description: "File path" },
    ];
    const normalResult: ExploreResult = {
      id: "chunk-1",
      score: 0.9,
      payload: { relativePath: "bar.ts", content: "const x = 1;" },
      // fromCodegraphFallback intentionally absent
    };
    const strategy = new FallbackTestStrategy([normalResult], payloadSignals);

    const results = await strategy.execute({
      collectionName: "col",
      limit: 10,
      metaOnly: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].fromCodegraphFallback).toBeUndefined();
  });
});
