import { describe, expect, it, vi } from "vitest";

import { TracePathOps } from "../../../../../src/core/api/internal/ops/trace-path-ops.js";
import { fileScopedSymbolKey } from "../../../../../src/core/contracts/types/codegraph.js";

/**
 * Traversal is keyed on `(relPath, symbolId)` (bd tea-rags-mcp-oxnvl), so these
 * fixtures give every symbol `X` the file `X.ts` — one file per symbol, no
 * namesakes, which is what keeps the pre-existing expectations below unchanged.
 * Namesake behaviour is covered in trace-path-namesakes.test.ts.
 */
function scopedGraphDb(adjacency: Record<string, string[]>) {
  const fileOf = (symbolId: string) => `${symbolId}.ts`;
  return {
    getCalleeEdgesScoped: vi.fn(async (refs: { relPath: string; symbolId: string }[]) => {
      const out = new Map<string, { relPath: string; symbolId: string }[]>();
      for (const ref of refs) {
        const targets = adjacency[ref.symbolId];
        if (!targets) continue;
        out.set(
          fileScopedSymbolKey(ref),
          targets.map((symbolId) => ({ relPath: fileOf(symbolId), symbolId })),
        );
      }
      return out;
    }),
    getSymbolRelPaths: vi.fn(
      async (ids: string[]) =>
        new Map(
          ids
            .filter((id) => adjacency[id] !== undefined || Object.values(adjacency).some((t) => t.includes(id)))
            .map((id) => [id, [fileOf(id)]]),
        ),
    ),
    close: vi.fn(async () => undefined),
  };
}

function makeOps(overrides: Partial<Record<string, unknown>> = {}) {
  const graphDb = scopedGraphDb({ A: ["B"], B: ["C"], C: [] });
  const pool = { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) };
  const qdrant = {
    scrollBySymbolIds: vi.fn(async (_c: string, ids: string[]) =>
      ids.map((id) => ({
        id,
        payload: {
          symbolId: id,
          relativePath: `${id}.ts`,
          startLine: 1,
          endLine: 9,
          git: { file: { bugFixRate: id === "B" ? 90 : 0 } },
        },
      })),
    ),
  };
  const reranker = {
    rerank: vi.fn(async (results: { payload?: { symbolId?: string } }[]) =>
      results.map((r) => ({
        ...r,
        score: r.payload?.symbolId === "B" ? 0.9 : 0.1,
        rankingOverlay: { preset: "bugHunt" },
      })),
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
    const res = await ops.tracePath({ collection: "c", from: "A", to: "C", rerank: "bugHunt" });
    expect(res.paths).toHaveLength(1);
    expect(res.paths[0].steps.map((s) => s.symbolId)).toEqual(["A", "B", "C"]);
    expect(res.paths[0].steps.every((s) => s.dangerOverlay)).toBe(true);
  });

  it("ranks the riskiest step first via dangerRanking and sets aggregateDanger to its max", async () => {
    const ops = makeOps();
    const res = await ops.tracePath({ collection: "c", from: "A", to: "C", rerank: "bugHunt" });
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

  // Same empty-vs-error contract as GraphFacade#withReadHandle (bd
  // tea-rags-mcp-kn2cb): "no path" is an assertion about the code, so it may
  // only be answered when the graph was actually read — or when there is no
  // graph database at all (codegraph never ran for this collection).
  it("surfaces the failure when the graph database exists but cannot be read", async () => {
    const pool = {
      acquireReader: vi.fn().mockRejectedValue(new Error("lock held")),
      hasDatabase: vi.fn().mockReturnValue(true),
    };
    const ops = makeOps({ pool });
    await expect(ops.tracePath({ collection: "c", from: "A", to: "C" })).rejects.toThrow(/lock held/);
  });

  it("returns empty paths when the collection has no graph database at all", async () => {
    const pool = {
      acquireReader: vi.fn().mockRejectedValue(new Error("no such file")),
      hasDatabase: vi.fn().mockReturnValue(false),
    };
    const ops = makeOps({ pool });
    expect(await ops.tracePath({ collection: "c", from: "A", to: "C" })).toEqual({ paths: [], truncated: false });
  });

  it("passes reorder:false to the reranker (annotate-only)", async () => {
    const reranker = {
      rerank: vi.fn(async (r: unknown[]) =>
        r.map((x) => ({ ...(x as object), score: 0, rankingOverlay: { preset: "bugHunt" } })),
      ),
    };
    const ops = makeOps({ reranker });
    await ops.tracePath({ collection: "c", from: "A", to: "C", rerank: "bugHunt" });
    expect(reranker.rerank).toHaveBeenCalledWith(
      expect.anything(),
      "bugHunt",
      "trace_path",
      expect.objectContaining({ reorder: false }),
    );
  });

  it("sorts the path list by aggregateDanger, most dangerous path first", async () => {
    // Diamond: A->B->D and A->C->D. C is the riskiest node (0.9); B is mild (0.2).
    const graphDb = scopedGraphDb({ A: ["B", "C"], B: ["D"], C: ["D"], D: [] });
    const pool = { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) };
    const danger: Record<string, number> = { A: 0.1, B: 0.2, C: 0.9, D: 0.1 };
    const qdrant = {
      scrollBySymbolIds: vi.fn(async (_c: string, ids: string[]) =>
        ids.map((id) => ({ id, payload: { symbolId: id, relativePath: `${id}.ts`, startLine: 1, endLine: 9 } })),
      ),
    };
    const reranker = {
      rerank: vi.fn(async (results: { payload?: { symbolId?: string } }[]) =>
        results.map((r) => ({
          ...r,
          score: danger[r.payload?.symbolId ?? ""] ?? 0,
          rankingOverlay: { preset: "bugHunt" },
        })),
      ),
    };
    const ops = new TracePathOps({
      pool: pool as never,
      qdrant: qdrant as never,
      reranker: reranker as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async (n: string) => n,
    });

    const res = await ops.tracePath({ collection: "c", from: "A", to: "D", rerank: "bugHunt" });
    expect(res.paths).toHaveLength(2);
    // The path through C (aggregateDanger 0.9) must come before the path through B (0.2).
    expect(res.paths[0].steps.map((s) => s.symbolId)).toEqual(["A", "C", "D"]);
    expect(res.paths[0].aggregateDanger).toBeCloseTo(0.9);
    expect(res.paths[1].steps.map((s) => s.symbolId)).toEqual(["A", "B", "D"]);
  });

  it("WITHOUT rerank returns lean steps with no danger overlay and no danger fields", async () => {
    const reranker = { rerank: vi.fn() };
    const ops = makeOps({ reranker });
    const res = await ops.tracePath({ collection: "c", from: "A", to: "C" });

    expect(res.paths).toHaveLength(1);
    const path = res.paths[0];
    expect(path.steps.map((s) => s.symbolId)).toEqual(["A", "B", "C"]);
    expect(path.steps.every((s) => s.dangerOverlay === undefined)).toBe(true);
    expect(path.dangerRanking).toBeUndefined();
    expect(path.aggregateDanger).toBeUndefined();
  });

  it("WITHOUT rerank does NOT invoke the reranker", async () => {
    const reranker = { rerank: vi.fn() };
    const ops = makeOps({ reranker });
    await ops.tracePath({ collection: "c", from: "A", to: "C" });
    expect(reranker.rerank).not.toHaveBeenCalled();
  });

  it("WITHOUT rerank keeps paths in enumeration order (no danger sort)", async () => {
    // Diamond A->B->D and A->C->D; without rerank both aggregateDanger absent,
    // so order is enumeration order, not danger-sorted.
    const graphDb = scopedGraphDb({ A: ["B", "C"], B: ["D"], C: ["D"], D: [] });
    const pool = { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) };
    const qdrant = {
      scrollBySymbolIds: vi.fn(async (_c: string, ids: string[]) =>
        ids.map((id) => ({ id, payload: { symbolId: id, relativePath: `${id}.ts`, startLine: 1, endLine: 9 } })),
      ),
    };
    const reranker = { rerank: vi.fn() };
    const ops = new TracePathOps({
      pool: pool as never,
      qdrant: qdrant as never,
      reranker: reranker as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async (n: string) => n,
    });

    const res = await ops.tracePath({ collection: "c", from: "A", to: "D" });
    expect(res.paths).toHaveLength(2);
    expect(reranker.rerank).not.toHaveBeenCalled();
    expect(res.paths.every((p) => p.aggregateDanger === undefined)).toBe(true);
    // enumeration order: A->B->D enumerated before A->C->D
    expect(res.paths[0].steps.map((s) => s.symbolId)).toEqual(["A", "B", "D"]);
    expect(res.paths[1].steps.map((s) => s.symbolId)).toEqual(["A", "C", "D"]);
  });
});

// bd tea-rags-mcp-kz89o: a step whose symbol has no chunk of its own (a short
// method folded into a class-body chunk, say) reported startLine 0 / endLine 0.
// The codegraph node knows the symbol's real range.
describe("TracePathOps.tracePath — step lines without a chunk", () => {
  function opsWithRanges(getSymbolLineRangesBulk: unknown) {
    const graphDb = { ...scopedGraphDb({ A: ["B"], B: ["C"], C: [] }), getSymbolLineRangesBulk };
    const pool = { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) };
    const qdrant = {
      // B has no chunk of its own.
      scrollBySymbolIds: vi.fn(async (_c: string, ids: string[]) =>
        ids
          .filter((id) => id !== "B")
          .map((id) => ({ id, payload: { symbolId: id, relativePath: `${id}.ts`, startLine: 1, endLine: 9 } })),
      ),
    };
    return new TracePathOps({
      pool: pool as never,
      qdrant: qdrant as never,
      reranker: { rerank: vi.fn() } as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async (n: string) => n,
    });
  }

  it("takes the step's line range from its codegraph node", async () => {
    const ranges = vi.fn(
      async () =>
        new Map([
          [
            "B.ts",
            {
              ranges: [
                { symbolId: "B", startLine: 40, endLine: 58 },
                { symbolId: "Other", startLine: 1, endLine: 10 },
              ],
              rowsWithoutRanges: 0,
            },
          ],
        ]),
    );

    const res = await opsWithRanges(ranges).tracePath({ collection: "c", from: "A", to: "C" });

    const b = res.paths[0].steps[1];
    expect(b.symbolId).toBe("B");
    expect({ startLine: b.startLine, endLine: b.endLine }).toEqual({ startLine: 40, endLine: 58 });
    // Steps that do have a chunk keep its lines.
    expect(res.paths[0].steps[0]).toMatchObject({ startLine: 1, endLine: 9 });
  });

  it("keeps 0 / 0 when the graph read of the ranges fails — a trace never fails on a range", async () => {
    const ranges = vi.fn(async () => {
      throw new Error("daemon gone");
    });

    const res = await opsWithRanges(ranges).tracePath({ collection: "c", from: "A", to: "C" });

    expect(res.paths[0].steps[1]).toMatchObject({ symbolId: "B", startLine: 0, endLine: 0 });
  });
});
