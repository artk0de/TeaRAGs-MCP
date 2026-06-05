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

  it("sorts the path list by aggregateDanger, most dangerous path first", async () => {
    // Diamond: A->B->D and A->C->D. C is the riskiest node (0.9); B is mild (0.2).
    const graphDb = {
      getCalleeEdges: vi.fn(async (ids: string[]) => {
        const g: Record<string, string[]> = { A: ["B", "C"], B: ["D"], C: ["D"], D: [] };
        return new Map(ids.filter((i) => g[i]).map((i) => [i, g[i]]));
      }),
      close: vi.fn(async () => undefined),
    };
    const pool = { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) };
    const danger: Record<string, number> = { A: 0.1, B: 0.2, C: 0.9, D: 0.1 };
    const qdrant = {
      scrollBySymbolIds: vi.fn(async (_c: string, ids: string[]) =>
        ids.map((id) => ({ id, payload: { symbolId: id, relativePath: `${id}.ts`, startLine: 1, endLine: 9 } })),
      ),
    };
    const reranker = {
      rerank: vi.fn(async (results: { payload?: { symbolId?: string } }[]) =>
        results.map((r) => ({ ...r, score: danger[r.payload?.symbolId ?? ""] ?? 0, rankingOverlay: { preset: "bugHunt" } })),
      ),
    };
    const ops = new TracePathOps({
      pool: pool as never,
      qdrant: qdrant as never,
      reranker: reranker as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async (n: string) => n,
    });

    const res = await ops.tracePath({ collection: "c", from: "A", to: "D" });
    expect(res.paths).toHaveLength(2);
    // The path through C (aggregateDanger 0.9) must come before the path through B (0.2).
    expect(res.paths[0].steps.map((s) => s.symbolId)).toEqual(["A", "C", "D"]);
    expect(res.paths[0].aggregateDanger).toBeCloseTo(0.9);
    expect(res.paths[1].steps.map((s) => s.symbolId)).toEqual(["A", "B", "D"]);
  });
});
