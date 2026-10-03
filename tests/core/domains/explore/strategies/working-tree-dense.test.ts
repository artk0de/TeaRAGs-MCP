/**
 * The dense floor on the vector strategies (bd tea-rags-mcp-xi2r9, WTO-5):
 * semantic_search and find_similar exclude the base rows of every file the
 * tree changed or deleted (one `has_id` over their base point ids) and rank the
 * tree's rows of those files by their OWN vectors — exact cosine against the
 * query vector, merged with the Qdrant page by score. A row without a vector
 * stays out and the marker says why; a view with no dense source keeps the
 * stale base rows flagged with `treeState`.
 */

import { describe, expect, it, vi } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { EmbeddingProvider } from "../../../../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import { payloadMatchesFilter } from "../../../../../src/core/adapters/qdrant/filters/payload-match.js";
import type { QdrantFilter } from "../../../../../src/core/adapters/qdrant/types.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { SimilarSearchStrategy } from "../../../../../src/core/domains/explore/strategies/similar.js";
import type { ExploreContext } from "../../../../../src/core/domains/explore/strategies/types.js";
import { VectorSearchStrategy } from "../../../../../src/core/domains/explore/strategies/vector.js";
import type {
  WorkingTreeDenseVectors,
  WorkingTreeView,
} from "../../../../../src/core/domains/explore/working-tree/index.js";

type Row = { id: string; score: number; payload: Record<string, unknown> };

const TOUCHED = "src/touched.ts";
const GONE = "src/gone.ts";

/** Base rows Qdrant would return, best first; two belong to files the tree touched. */
const BASE: Row[] = [
  { id: "b1", score: 0.9, payload: { relativePath: "src/a.ts", language: "typescript" } },
  { id: "bt", score: 0.85, payload: { relativePath: TOUCHED, language: "typescript" } },
  { id: "b2", score: 0.7, payload: { relativePath: "src/b.ts", language: "typescript" } },
  { id: "bg", score: 0.6, payload: { relativePath: GONE, language: "typescript" } },
  { id: "b3", score: 0.5, payload: { relativePath: "src/c.ts", language: "typescript" } },
];

const BASE_POINTS = new Map([
  [TOUCHED, [{ id: "bt", payload: { relativePath: TOUCHED } }]],
  [GONE, [{ id: "bg", payload: { relativePath: GONE } }]],
]);

/** The query vector; a tree row's vector is chosen for the cosine it scores against it. */
const QUERY = [1, 0];
const withCosine = (c: number): number[] => [c, Math.sqrt(1 - c * c)];

function excludedIds(filter: QdrantFilter | undefined): Set<string> {
  const ids = new Set<string>();
  for (const condition of (filter?.must_not as Record<string, unknown>[] | undefined) ?? []) {
    for (const id of (condition.has_id as string[] | undefined) ?? []) ids.add(id);
  }
  return ids;
}

const payloadAdmits = (row: Row, filter: QdrantFilter | undefined): boolean => {
  if (!filter) return true;
  const { must_not: _ignored, ...rest } = filter;
  return Object.keys(rest).length === 0 || payloadMatchesFilter(row.payload, rest);
};

/** A Qdrant that honours the request filter (payload conditions and `has_id`) on search, groups and recommend. */
function qdrantHolding(rows: Row[] = BASE) {
  const page = (limit: number, filter: QdrantFilter | undefined) =>
    rows.filter((row) => !excludedIds(filter).has(row.id) && payloadAdmits(row, filter)).slice(0, limit);
  const search = vi.fn(async (_c: string, _v: number[], limit: number, filter?: QdrantFilter) => page(limit, filter));
  const queryGroups = vi.fn(async (_c: string, _v: number[], o: { limit: number; filter?: QdrantFilter }) =>
    page(o.limit, o.filter),
  );
  const query = vi.fn(async (_c: string, o: { limit: number; filter?: QdrantFilter }) => page(o.limit, o.filter));
  const retrieveDenseVectors = vi.fn(async (_c: string, ids: readonly (string | number)[]) =>
    ids.map((id) => ({ id, vector: withCosine(0.95) })),
  );
  const qdrant = {
    search,
    queryGroups,
    query,
    retrieveDenseVectors,
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false, pointsCount: rows.length }),
    scrollFiltered: vi.fn().mockResolvedValue([]),
  } as unknown as QdrantManager;
  return { qdrant, search, queryGroups, query };
}

const reranker = { rerank: vi.fn((r: unknown[]) => r) } as unknown as Reranker;

const fresh = codeRow("t-fresh", { relativePath: TOUCHED, symbolId: "freshHelper", content: "fresh" });
const weak = codeRow("t-weak", { relativePath: TOUCHED, symbolId: "weakHelper", content: "weak" });

const DENSE: WorkingTreeDenseVectors = {
  vectors: new Map([
    ["t-fresh", withCosine(0.8)],
    ["t-weak", withCosine(0.3)],
  ]),
  pending: 0,
};

const treeView = (dense: WorkingTreeDenseVectors | undefined = DENSE, rows = [fresh, weak]): WorkingTreeView =>
  fakeWorkingTreeView({
    changed: [TOUCHED],
    deleted: [GONE],
    rows,
    basePoints: BASE_POINTS,
    ...(dense ? { dense } : {}),
  });

async function semantic(view: WorkingTreeView | undefined, ctx: Partial<ExploreContext> = {}) {
  const { qdrant, search, queryGroups } = qdrantHolding();
  const results = await new VectorSearchStrategy(qdrant, reranker, [], []).execute({
    collectionName: "c",
    embedding: QUERY,
    limit: 10,
    ...(view ? { workingTreeView: view } : {}),
    ...ctx,
  });
  return { results, search, queryGroups };
}

describe("semantic_search dense floor", () => {
  it("ranks the tree's rows of a changed file by their own vectors, merged with the base page by score", async () => {
    const { results } = await semantic(treeView());

    expect(results.map((r) => r.id)).toEqual(["b1", "t-fresh", "b2", "b3", "t-weak"]);
    expect(results.find((r) => r.id === "t-fresh")?.score).toBeCloseTo(0.8, 10);
  });

  it("excludes the touched files' base rows from the Qdrant request by their point ids", async () => {
    const { search } = await semantic(treeView(), {
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
    });

    const sent = search.mock.calls[0][3] as QdrantFilter;
    expect(sent.must).toEqual([{ key: "language", match: { value: "typescript" } }]);
    expect(sent.must_not).toEqual([{ has_id: ["bt", "bg"] }]);
  });

  it("claims the chunks and dense floors, and stamps no treeState", async () => {
    const view = treeView();
    const { results } = await semantic(view);

    expect(view.marker.floors).toEqual(["chunks", "dense"]);
    expect(view.marker.denseUnavailable).toBeUndefined();
    expect(results.every((r) => r.treeState === undefined)).toBe(true);
  });

  it("holds the tree's rows to the request filter and the exact pathPattern", async () => {
    const python = codeRow("t-py", { relativePath: TOUCHED, language: "python", content: "py" });
    const dense = { vectors: new Map([["t-py", withCosine(0.99)]]), pending: 0 };
    const filtered = await semantic(treeView(dense, [python]), {
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
    });
    const patterned = await semantic(treeView(), { pathPattern: "src/a.ts" });

    expect(filtered.results.map((r) => r.id)).not.toContain("t-py");
    expect(patterned.results.map((r) => r.id)).not.toContain("t-fresh");
  });

  it("leaves a row without a vector out and says why on the marker, without claiming dense", async () => {
    const view = treeView({ vectors: new Map(), pending: 2, failure: "connect ECONNREFUSED 127.0.0.1:1" });
    const { results } = await semantic(view);

    expect(results.map((r) => r.id)).toEqual(["b1", "b2", "b3"]);
    expect(view.marker.floors).toEqual([]);
    expect(view.marker.denseUnavailable).toEqual({ reason: "connect ECONNREFUSED 127.0.0.1:1" });
  });

  it("names the pending rows when the vectors are still being made", async () => {
    const view = treeView({ vectors: new Map([["t-fresh", withCosine(0.8)]]), pending: 1 });
    const { results } = await semantic(view);

    expect(results.map((r) => r.id)).toContain("t-fresh");
    expect(results.map((r) => r.id)).not.toContain("t-weak");
    expect(view.marker.floors).toEqual(["chunks", "dense"]);
    expect(view.marker.denseUnavailable).toEqual({ reason: "1 row pending" });
  });

  it("groups the tree's rows with the base rows at level file", async () => {
    const { results, queryGroups } = await semantic(treeView(), { level: "file" });

    expect((queryGroups.mock.calls[0][2] as { filter: QdrantFilter }).filter.must_not).toEqual([
      { has_id: ["bt", "bg"] },
    ]);
    expect(results.map((r) => r.payload?.relativePath)).toEqual(["src/a.ts", TOUCHED, "src/b.ts", "src/c.ts"]);
    expect(results[1].id).toBe("t-fresh");
  });

  it("without a dense source keeps the request and flags the stale base rows instead", async () => {
    const view = fakeWorkingTreeView({ changed: [TOUCHED], deleted: [GONE], rows: [fresh] });
    const { results, search } = await semantic(view);

    expect(search.mock.calls[0][3]).toBeUndefined();
    expect(results.find((r) => r.id === "bt")?.treeState).toBe("modified");
    expect(view.marker.floors).toEqual([]);
  });

  it("sends today's request and claims nothing on a clean tree", async () => {
    const without = await semantic(undefined);
    const clean = fakeWorkingTreeView({ rows: [], dense: { vectors: new Map(), pending: 0 } });
    const withView = await semantic(clean);

    expect(withView.search.mock.calls).toEqual(without.search.mock.calls);
    expect(JSON.stringify(withView.results)).toBe(JSON.stringify(without.results));
    expect(clean.marker.floors).toEqual([]);
  });
});

describe("find_similar dense floor", () => {
  const embeddings = {
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: QUERY, dimensions: 2 }))),
  } as unknown as EmbeddingProvider;

  async function similar(view: WorkingTreeView, input: ConstructorParameters<typeof SimilarSearchStrategy>[5]) {
    const { qdrant, query } = qdrantHolding();
    vi.mocked(embeddings.embedBatch).mockClear();
    const results = await new SimilarSearchStrategy(qdrant, reranker, [], [], embeddings, input).execute({
      collectionName: "c",
      limit: 10,
      workingTreeView: view,
    });
    return { results, query };
  }

  it("ranks the tree's rows by their own vectors against a tree positive, using its vector without re-embedding", async () => {
    // Delta row ids are stored point ids (UUIDs), the form a caller hands back.
    const FRESH = "00000000-0000-4000-8000-000000000001";
    const WEAK = "00000000-0000-4000-8000-000000000002";
    const view = treeView(
      {
        vectors: new Map([
          [FRESH, QUERY],
          [WEAK, withCosine(0.3)],
        ]),
        pending: 0,
      },
      [
        { ...fresh, id: FRESH },
        { ...weak, id: WEAK },
      ],
    );
    const { results, query } = await similar(view, { positiveIds: [FRESH] });

    expect(embeddings.embedBatch).not.toHaveBeenCalled();
    expect((query.mock.calls[0][1] as { positive: unknown[] }).positive).toEqual([QUERY]);
    // The positive itself is not a result, as Qdrant leaves a positive id out.
    expect(results.map((r) => r.id)).not.toContain(FRESH);
    const weakScore = 0.5 * (0.3 / 1.3 + 1);
    expect(results.find((r) => r.id === WEAK)?.score).toBeCloseTo(weakScore, 10);
    expect(view.marker.floors).toEqual(["chunks", "dense"]);
  });

  it("scores the tree's rows against a base positive by that point's stored vector", async () => {
    const view = treeView();
    const { results, query } = await similar(view, { positiveIds: ["b1"] });

    const sent = query.mock.calls[0][1] as { positive: unknown[]; filter: QdrantFilter; offset?: number };
    expect(sent.positive).toEqual(["b1"]);
    expect(sent.filter.must_not).toEqual([{ has_id: ["bt", "bg"] }]);
    const freshScore = results.find((r) => r.id === "t-fresh")?.score ?? 0;
    // cos(withCosine(0.95), withCosine(0.8)) through Qdrant's scaled sigmoid.
    const cos = 0.95 * 0.8 + Math.sqrt(1 - 0.95 ** 2) * Math.sqrt(1 - 0.8 ** 2);
    expect(freshScore).toBeCloseTo(0.5 * (cos / (1 + cos) + 1), 10);
    expect(results.map((r) => r.id)).not.toContain("bt");
  });

  it("answers the base page and names why when a base example's stored vector cannot be read", async () => {
    const view = treeView();
    const { qdrant } = qdrantHolding();
    vi.mocked(qdrant.retrieveDenseVectors).mockRejectedValue(new Error("qdrant timeout"));
    const results = await new SimilarSearchStrategy(qdrant, reranker, [], [], embeddings, {
      positiveIds: ["b1"],
    }).execute({ collectionName: "c", limit: 10, workingTreeView: view });

    expect(results.map((r) => r.id)).toEqual(["b1", "b2", "b3"]);
    expect(view.marker.floors).toEqual([]);
    expect(view.marker.denseUnavailable?.reason).toContain("qdrant timeout");
  });
});
