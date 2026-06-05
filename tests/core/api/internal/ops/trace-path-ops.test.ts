import { describe, expect, it, vi } from "vitest";

import { TracePathOps } from "../../../../../src/core/api/internal/ops/trace-path-ops.js";

function makeOps(overrides: Partial<Record<string, unknown>> = {}) {
  const graphDb = {
    getCalleeEdges: vi.fn(async (ids: string[]) => {
      const g: Record<string, string[]> = { A: ["B"], B: ["C"], C: [] };
      return new Map(ids.filter((i) => g[i]).map((i) => [i, g[i]]));
    }),
    close: vi.fn(async () => undefined),
  };
  const pool = { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) };
  const qdrant = {
    scrollBySymbolIds: vi.fn(async (_c: string, ids: string[]) =>
      ids.map((id) => ({
        id,
        payload: { symbolId: id, relativePath: `${id}.ts`, startLine: 1, endLine: 9, git: { file: { bugFixRate: id === "B" ? 90 : 0 } } },
      })),
    ),
  };
  const reranker = {
    rerank: vi.fn(async (results: { payload?: { symbolId?: string } }[]) =>
      results.map((r) => ({ ...r, score: r.payload?.symbolId === "B" ? 0.9 : 0.1, rankingOverlay: { preset: "bugHunt" } })),
    ),
  };
  const collectionRegistry = {};
  return new TracePathOps({
    pool: pool as never,
    qdrant: qdrant as never,
    reranker: reranker as never,
    collectionRegistry: collectionRegistry as never,
    resolveActiveCollection: async (n: string) => n,
    ...overrides,
  });
}

describe("TracePathOps.tracePath", () => {
  it("returns the A->B->C path in execution order with danger overlays", async () => {
    const ops = makeOps();
    const res = await ops.tracePath({ collection: "c", from: "A", to: "C" });
    expect(res.paths).toHaveLength(1);
    expect(res.paths[0].steps.map((s) => s.symbolId)).toEqual(["A", "B", "C"]);
    expect(res.paths[0].steps.every((s) => s.dangerOverlay)).toBe(true);
  });

  it("ranks the riskiest step first via dangerRanking and sets aggregateDanger to its max", async () => {
    const ops = makeOps();
    const res = await ops.tracePath({ collection: "c", from: "A", to: "C" });
    const path = res.paths[0];
    expect(path.steps[path.dangerRanking[0]].symbolId).toBe("B");
    expect(path.aggregateDanger).toBeCloseTo(0.9);
  });

  it("returns empty paths when no route exists, without throwing", async () => {
    const ops = makeOps();
    const res = await ops.tracePath({ collection: "c", from: "A", to: "Z" });
    expect(res.paths).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it("passes reorder:false to the reranker (annotate-only)", async () => {
    const reranker = { rerank: vi.fn(async (r: unknown[]) => r.map((x) => ({ ...(x as object), score: 0, rankingOverlay: { preset: "bugHunt" } }))) };
    const ops = makeOps({ reranker: reranker as never });
    await ops.tracePath({ collection: "c", from: "A", to: "C" });
    expect(reranker.rerank).toHaveBeenCalledWith(expect.anything(), "bugHunt", "semantic_search", expect.objectContaining({ reorder: false }));
  });
});
