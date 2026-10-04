/**
 * hybrid_search's dense leg on a working tree (bd tea-rags-mcp-xi2r9, WTO-5):
 * the tree's rows of touched files rank on the dense leg by their own vectors
 * (exact cosine against the query vector), beside the sparse and identity legs,
 * and the legs fuse with Qdrant's RRF (k = 2). Without it a non-lexical query
 * dropped every touched file (live round-2 probe D3: 9 of 9 gone).
 */

import { describe, expect, it, vi } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { HybridSearchStrategy } from "../../../../../src/core/domains/explore/strategies/hybrid.js";
import type { ExploreContext } from "../../../../../src/core/domains/explore/strategies/types.js";
import type {
  WorkingTreeDenseVectors,
  WorkingTreeView,
} from "../../../../../src/core/domains/explore/working-tree/index.js";
import { QDRANT_DEFAULT_RRF_K } from "../../../../../src/core/domains/explore/working-tree/sparse-floor.js";

const TOUCHED = "src/touched.ts";
const QUERY = [1, 0];
const withCosine = (c: number): number[] => [c, Math.sqrt(1 - c * c)];
const rrf = (position: number): number => 1 / (position + QDRANT_DEFAULT_RRF_K);

const reranker = { rerank: vi.fn((r: unknown[]) => r) } as unknown as Reranker;

async function run(view: WorkingTreeView, ctx: Partial<ExploreContext> = {}) {
  const qdrant = {
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 1 }),
    hybridSearch: vi.fn().mockResolvedValue([]),
    scrollFiltered: vi.fn().mockResolvedValue([]),
  } as unknown as QdrantManager;
  return new HybridSearchStrategy(qdrant, reranker, [], []).execute({
    collectionName: "c",
    embedding: QUERY,
    query: "retry after a transient failure",
    limit: 10,
    workingTreeView: view,
    ...ctx,
  });
}

const near = codeRow("t-near", { relativePath: TOUCHED, symbolId: "backoff", content: "sleep(delay); delay *= 2;" });
const far = codeRow("t-far", { relativePath: TOUCHED, symbolId: "render", content: "return html;" });

const view = (dense: WorkingTreeDenseVectors, rows = [near, far]) =>
  fakeWorkingTreeView({ changed: [TOUCHED], rows, dense, basePoints: new Map() });

describe("HybridSearchStrategy working-tree dense leg", () => {
  it("ranks a tree row that shares no term with the query by its own vector", async () => {
    const results = await run(
      view({
        vectors: new Map([
          ["t-near", withCosine(0.9)],
          ["t-far", withCosine(0.2)],
        ]),
        pending: 0,
      }),
    );

    expect(results.map((r) => r.id)).toEqual(["t-near", "t-far"]);
    expect(results[0].score).toBeCloseTo(rrf(0), 10);
    expect(results[1].score).toBeCloseTo(rrf(1), 10);
  });

  it("adds the dense rank to the sparse rank of the same row", async () => {
    const lexical = codeRow("t-lex", { relativePath: TOUCHED, content: "retry after failure" });
    const results = await run(
      view(
        {
          vectors: new Map([
            ["t-near", withCosine(0.9)],
            ["t-lex", withCosine(0.5)],
          ]),
          pending: 0,
        },
        [near, lexical],
      ),
    );

    // t-lex: sparse #0 + dense #1; t-near: dense #0 only.
    expect(results.find((r) => r.id === "t-lex")?.score).toBeCloseTo(rrf(0) + rrf(1), 10);
    expect(results.find((r) => r.id === "t-near")?.score).toBeCloseTo(rrf(0), 10);
  });

  it("orders the identity leg by the dense score, as the server's identity prefetch does", async () => {
    const a = codeRow("t-a", { relativePath: TOUCHED, symbolId: "retryAfter", content: "a" });
    const b = codeRow("t-b", { relativePath: TOUCHED, symbolId: "retryAfter", content: "b" });
    const results = await run(
      view(
        {
          vectors: new Map([
            ["t-a", withCosine(0.1)],
            ["t-b", withCosine(0.9)],
          ]),
          pending: 0,
        },
        [a, b],
      ),
      { query: "retryAfter" },
    );

    // Each ranks on the dense leg and on the identity leg, in the same cosine order.
    expect(results.find((r) => r.id === "t-b")?.score).toBeCloseTo(2 * rrf(0), 10);
    expect(results.find((r) => r.id === "t-a")?.score).toBeCloseTo(2 * rrf(1), 10);
  });

  it("claims the dense floor beside chunks and sparse when a row ranked by its vector", async () => {
    const v = view({ vectors: new Map([["t-near", withCosine(0.9)]]), pending: 1 });
    await run(v);

    expect(v.marker.floors).toEqual(["chunks", "sparse", "dense"]);
    expect(v.marker.denseUnavailable).toEqual({ reason: "1 row pending" });
  });

  it("keeps a row without a vector on the sparse leg and says why the dense leg lacks it", async () => {
    const lexical = codeRow("t-lex", { relativePath: TOUCHED, content: "retry after failure" });
    const v = view({ vectors: new Map(), pending: 1, failure: "connect ECONNREFUSED" }, [lexical]);
    const results = await run(v);

    expect(results.map((r) => r.id)).toEqual(["t-lex"]);
    expect(v.marker.floors).toEqual(["chunks", "sparse"]);
    expect(v.marker.denseUnavailable).toEqual({ reason: "connect ECONNREFUSED" });
  });
});
