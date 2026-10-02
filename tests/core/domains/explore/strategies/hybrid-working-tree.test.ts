/**
 * HybridSearchStrategy on a working tree (bd tea-rags-mcp-xi2r9.4): hybrid has
 * the sparse floor. The Qdrant request excludes the base rows of every file the
 * tree changed or deleted; the tree's rows of those files are scored locally —
 * BM25 dot product with the query's sparse vector, plus the identity leg — and
 * fused into the base page with Qdrant's own RRF arithmetic.
 */

import { describe, expect, it, vi } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import { payloadMatchesFilter } from "../../../../../src/core/adapters/qdrant/filters/payload-match.js";
import type { QdrantFilter } from "../../../../../src/core/adapters/qdrant/types.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { HybridSearchStrategy } from "../../../../../src/core/domains/explore/strategies/hybrid.js";
import type { ExploreContext } from "../../../../../src/core/domains/explore/strategies/types.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";
import { QDRANT_DEFAULT_RRF_K } from "../../../../../src/core/domains/explore/working-tree/sparse-floor.js";

type Row = { id: string; score: number; payload: Record<string, unknown> };

const TOUCHED = "src/touched.ts";
const GONE = "src/gone.ts";

/** Base rows Qdrant would fuse, best first; two of them belong to files the tree touched. */
const BASE: Row[] = [
  { id: "b1", score: 0.9, payload: { relativePath: "src/a.ts", language: "typescript", content: "a" } },
  { id: "bt", score: 0.8, payload: { relativePath: TOUCHED, language: "typescript", content: "staleHelper()" } },
  { id: "b2", score: 0.7, payload: { relativePath: "src/b.ts", language: "typescript", content: "b" } },
  { id: "bg", score: 0.6, payload: { relativePath: GONE, language: "typescript", content: "gone" } },
  { id: "b3", score: 0.5, payload: { relativePath: "src/c.ts", language: "typescript", content: "c" } },
];

/** A Qdrant that honours the request filter, as the server does. */
function qdrantHolding(rows: Row[]) {
  const hybridSearch = vi.fn(async (...args: unknown[]) => {
    const [, , , limit, filter] = args as [string, number[], unknown, number, QdrantFilter | undefined];
    return rows.filter((row) => !filter || payloadMatchesFilter(row.payload, filter)).slice(0, limit);
  });
  const qdrant = {
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true }),
    hybridSearch,
    scrollFiltered: vi.fn().mockResolvedValue([]),
  } as unknown as QdrantManager;
  return { qdrant, hybridSearch };
}

const reranker = { rerank: vi.fn((r: unknown[]) => r) } as unknown as Reranker;

async function run(view: WorkingTreeView | undefined, ctx: Partial<ExploreContext> = {}, rows: Row[] = BASE) {
  const { qdrant, hybridSearch } = qdrantHolding(rows);
  const results = await new HybridSearchStrategy(qdrant, reranker, [], []).execute({
    collectionName: "c",
    embedding: [0.1, 0.2],
    query: "freshHelper",
    limit: 3,
    ...(view ? { workingTreeView: view } : {}),
    ...ctx,
  });
  return { results, hybridSearch };
}

const freshRow = codeRow("t1", {
  relativePath: TOUCHED,
  symbolId: "freshHelper",
  content: "export function freshHelper() { return 1; }",
});

const treeView = (rows = [freshRow]) => fakeWorkingTreeView({ changed: [TOUCHED], deleted: [GONE], rows });

describe("HybridSearchStrategy working-tree sparse floor", () => {
  it("finds an identifier that exists only in the tree", async () => {
    const { results } = await run(treeView());

    expect(results.map((r) => r.id)).toContain("t1");
  });

  it("scores a tree row with Qdrant's RRF arithmetic: one 1/(k + position) per leg it ranks in", async () => {
    const { results } = await run(treeView());

    // Rank 0 on the sparse leg AND on the identity leg.
    const expected = 2 / (QDRANT_DEFAULT_RRF_K + 0);
    expect(results.find((r) => r.id === "t1")?.score).toBeCloseTo(expected, 10);
  });

  it("does not return an identifier that exists only in a base row of a touched file", async () => {
    const tree = codeRow("t2", { relativePath: TOUCHED, symbolId: "other", content: "nothing relevant here" });
    const { results } = await run(treeView([tree]), { query: "staleHelper", limit: 10 });

    expect(results.map((r) => r.id)).not.toContain("bt");
    expect(results.map((r) => r.id)).not.toContain("t2");
  });

  it("drops the base rows of deleted files", async () => {
    const { results } = await run(treeView(), { limit: 10 });

    expect(results.map((r) => r.id)).not.toContain("bg");
  });

  it("keeps the order of base rows of untouched files", async () => {
    const { results } = await run(treeView(), { limit: 10 });

    expect(results.filter((r) => r.id !== "t1").map((r) => r.id)).toEqual(["b1", "b2", "b3"]);
  });

  it("excludes touched files from the Qdrant request through the request filter", async () => {
    const languageFilter = { must: [{ key: "language", match: { value: "typescript" } }] };
    const { hybridSearch } = await run(treeView(), { filter: languageFilter });

    const sentFilter = hybridSearch.mock.calls[0][4] as QdrantFilter;
    expect(sentFilter.must).toEqual(languageFilter.must);
    expect(payloadMatchesFilter({ relativePath: TOUCHED, language: "typescript" }, sentFilter)).toBe(false);
    expect(payloadMatchesFilter({ relativePath: GONE, language: "typescript" }, sentFilter)).toBe(false);
    expect(payloadMatchesFilter({ relativePath: "src/a.ts", language: "typescript" }, sentFilter)).toBe(true);
  });

  it("holds tree rows to the request filter the base rows were held to", async () => {
    const python = codeRow("py", {
      relativePath: TOUCHED,
      language: "python",
      symbolId: "freshHelper",
      content: "def freshHelper(): pass",
    });
    const { results } = await run(treeView([python]), {
      limit: 10,
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
    });

    expect(results.map((r) => r.id)).not.toContain("py");
  });

  it("holds tree rows to the exact pathPattern", async () => {
    const { results } = await run(treeView(), { limit: 10, pathPattern: "src/a.ts" });

    expect(results.map((r) => r.id)).not.toContain("t1");
  });

  it("puts no treeState on rows of touched files — they come from the tree", async () => {
    const { results } = await run(treeView(), { limit: 10 });

    expect(results.every((r) => r.treeState === undefined)).toBe(true);
  });

  it("groups tree rows with base rows at level file", async () => {
    const second = codeRow("t3", {
      relativePath: TOUCHED,
      symbolId: "freshHelper.inner",
      parentSymbolId: "freshHelper",
      content: "freshHelper inner",
    });
    const { results } = await run(treeView([freshRow, second]), { level: "file", limit: 10 });

    const paths = results.map((r) => r.payload?.relativePath);
    expect(paths.filter((p) => p === TOUCHED)).toHaveLength(1);
    expect(["t1", "t3"]).toContain(results.find((r) => r.payload?.relativePath === TOUCHED)?.id);
    expect(paths).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts", "src/c.ts", TOUCHED]));
  });

  it("sends today's exact request and returns today's results when the tree touched nothing", async () => {
    const without = await run(undefined, { limit: 10, filter: { must: [{ key: "language", match: { value: "x" } }] } });
    const withView = await run(fakeWorkingTreeView({ rows: [] }), {
      limit: 10,
      filter: { must: [{ key: "language", match: { value: "x" } }] },
    });

    expect(withView.hybridSearch.mock.calls).toEqual(without.hybridSearch.mock.calls);
    expect(JSON.stringify(withView.results)).toBe(JSON.stringify(without.results));
  });

  it("without a chunk layer leaves the request alone and flags the stale rows instead", async () => {
    const without = await run(undefined, { limit: 10 });
    const noLayer = await run(fakeWorkingTreeView({ changed: [TOUCHED], deleted: [GONE] }), { limit: 10 });

    expect(noLayer.hybridSearch.mock.calls).toEqual(without.hybridSearch.mock.calls);
    expect(noLayer.results.find((r) => r.id === "bt")?.treeState).toBe("modified");
    expect(noLayer.results.find((r) => r.id === "bg")?.treeState).toBe("deleted");
  });

  it("hydrates a tree test example with the tree's setup", async () => {
    const SPEC = "tests/user.test.ts";
    const header = 'describe("User", () => {';
    const setup = codeRow("setup", {
      symbolId: "User.setup",
      relativePath: SPEC,
      chunkType: "test_setup",
      startLine: 2,
      scopeLineRanges: [{ start: 1, end: 20 }],
      memberRowCounts: [1],
      content: `${header}\n  const user = treeUser();`,
    });
    const example = codeRow("ex", {
      symbolId: "User.works",
      parentSymbolId: "User",
      parentType: "test_scope",
      chunkType: "test",
      relativePath: SPEC,
      startLine: 5,
      content: `${header}\n  it("works", () => { freshHelper(); });`,
    });
    const { results } = await run(fakeWorkingTreeView({ changed: [SPEC], rows: [setup, example] }), { limit: 10 });

    expect(String(results.find((r) => r.id === "ex")?.payload?.content)).toContain("treeUser()");
  });
});
