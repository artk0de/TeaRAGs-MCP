/**
 * trace_path's danger rerank reads the index's history clock (bd
 * tea-rags-mcp-zwu7m): a head-anchored index derives age / recency from its
 * indexed commit's time; a wall-clock index passes the options it always did.
 */
import { describe, expect, it, vi } from "vitest";

import { TracePathOps } from "../../../../../src/core/api/internal/ops/trace-path-ops.js";
import { fileScopedSymbolKey } from "../../../../../src/core/contracts/types/codegraph.js";

const HEAD_SEC = 1_550_000_000;

function makeOps(historyAnchorSec: number | undefined) {
  const adjacency: Record<string, string[]> = { A: ["B"], B: [] };
  const graphDb = {
    getCalleeEdgesScoped: vi.fn(async (refs: { relPath: string; symbolId: string }[]) => {
      const out = new Map<string, { relPath: string; symbolId: string }[]>();
      for (const ref of refs) {
        const targets = adjacency[ref.symbolId] ?? [];
        out.set(
          fileScopedSymbolKey(ref),
          targets.map((symbolId) => ({ relPath: `${symbolId}.ts`, symbolId })),
        );
      }
      return out;
    }),
    getSymbolRelPaths: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, [`${id}.ts`]]))),
    close: vi.fn(async () => undefined),
  };
  const reranker = {
    rerank: vi.fn(async (results: object[]) =>
      results.map((r) => ({ ...r, score: 0.5, rankingOverlay: { preset: "hotspots" } })),
    ),
  };
  const historyAnchor = { anchorSecOf: vi.fn(async () => historyAnchorSec) };
  const ops = new TracePathOps({
    pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
    qdrant: {
      scrollBySymbolIds: vi.fn(async (_c: string, ids: string[]) =>
        ids.map((id) => ({ id, payload: { symbolId: id, relativePath: `${id}.ts`, startLine: 1, endLine: 9 } })),
      ),
    } as never,
    reranker: reranker as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (n: string) => n as never,
    historyAnchor,
  });
  return { ops, reranker, historyAnchor };
}

describe("TracePathOps danger rerank under the index's history clock", () => {
  it("a head-anchored index reranks at its indexed commit's time", async () => {
    const { ops, reranker, historyAnchor } = makeOps(HEAD_SEC);
    await ops.tracePath({ collection: "c", from: "A", to: "B", rerank: "hotspots" });
    expect(historyAnchor.anchorSecOf).toHaveBeenCalledWith("c");
    expect(reranker.rerank).toHaveBeenCalledWith(expect.anything(), "hotspots", "trace_path", {
      reorder: false,
      now: HEAD_SEC,
    });
  });

  it("a wall-clock index passes exactly the options it passed before", async () => {
    const { ops, reranker } = makeOps(undefined);
    await ops.tracePath({ collection: "c", from: "A", to: "B", rerank: "hotspots" });
    expect(reranker.rerank).toHaveBeenCalledWith(expect.anything(), "hotspots", "trace_path", { reorder: false });
  });
});
