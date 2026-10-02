/**
 * The sparse floor's per-query cost (bd tea-rags-mcp-xi2r9, live probe P2-6):
 * with 159 touched files hybrid_search took 365 ms against semantic_search's
 * 40 ms. Two parts of it grew with the delta:
 *
 * - the BM25 vector of every delta row was recomputed on every query — it is
 *   now computed once per row;
 * - the exclusion of touched files was a 159-branch `should` of text+value
 *   pairs evaluated per candidate (131–280 ms on the live self-index; a bare
 *   `match.any` is no better on the text-indexed `relativePath`, 207–311 ms).
 *   It is now a `has_id` exclusion of the touched files' base point ids
 *   (5–8 ms), the ids resolved once per touched set and index revision.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { payloadMatchesFilter } from "../../../../../src/core/adapters/qdrant/filters/payload-match.js";
import * as sparse from "../../../../../src/core/adapters/qdrant/sparse.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import {
  excludeWorkingTreeBaseIds,
  scoreWorkingTreeRows,
  WorkingTreeTouchedBaseIds,
} from "../../../../../src/core/domains/explore/working-tree/sparse-floor.js";

vi.mock("../../../../../src/core/adapters/qdrant/sparse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof sparse>();
  return { ...actual, generateSparseVector: vi.fn(actual.generateSparseVector) };
});

const row = (id: string, content: string, relativePath = "src/a.ts"): ScrollChunk => ({
  id,
  payload: { relativePath, content, language: "typescript" },
});

describe("scoreWorkingTreeRows — one BM25 vector per row", () => {
  afterEach(() => {
    vi.mocked(sparse.generateSparseVector).mockClear();
  });

  it("should vectorize each row once across queries", () => {
    const rows = [row("t1", "export function freshHelper() {}"), row("t2", "const other = 1;")];
    const scoring = (query: string) => ({ querySparse: sparse.generateSparseVector(query), legLimit: 10 });

    const first = scoreWorkingTreeRows(rows, scoring("freshHelper"));
    const second = scoreWorkingTreeRows(rows, scoring("other"));

    expect(first.map((r) => r.id)).toEqual(["t1"]);
    expect(second.map((r) => r.id)).toEqual(["t2"]);
    // two query vectors + two row vectors — the rows were not re-vectorized for the second query
    expect(sparse.generateSparseVector).toHaveBeenCalledTimes(4);
  });

  it("should re-vectorize a row whose content changed", () => {
    const edited = row("t1", "export function freshHelper() {}");
    scoreWorkingTreeRows([edited], { querySparse: sparse.generateSparseVector("freshHelper"), legLimit: 10 });
    edited.payload.content = "export function renamedHelper() {}";

    const scored = scoreWorkingTreeRows([edited], {
      querySparse: sparse.generateSparseVector("renamedHelper"),
      legLimit: 10,
    });

    expect(scored.map((r) => r.id)).toEqual(["t1"]);
  });
});

describe("excludeWorkingTreeBaseIds", () => {
  it("should add one has_id condition to must_not and keep the rest of the filter", () => {
    const must = [{ key: "language", match: { value: "typescript" } }];

    expect(excludeWorkingTreeBaseIds({ must }, ["b1", "b2"])).toEqual({ must, must_not: [{ has_id: ["b1", "b2"] }] });
    expect(excludeWorkingTreeBaseIds({ must, must_not: [{ key: "isTest", match: { value: true } }] }, ["b1"])).toEqual({
      must,
      must_not: [{ key: "isTest", match: { value: true } }, { has_id: ["b1"] }],
    });
  });

  it("should expand the flat form and accept an absent filter", () => {
    expect(excludeWorkingTreeBaseIds(undefined, ["b1"])).toEqual({ must_not: [{ has_id: ["b1"] }] });
    expect(excludeWorkingTreeBaseIds({ language: "ruby" }, ["b1"])).toEqual({
      must: [{ key: "language", match: { value: "ruby" } }],
      must_not: [{ has_id: ["b1"] }],
    });
  });

  it("should leave the filter alone when the touched files have no base rows", () => {
    const filter = { must: [{ key: "language", match: { value: "typescript" } }] };

    expect(excludeWorkingTreeBaseIds(filter, [])).toBe(filter);
    expect(excludeWorkingTreeBaseIds(undefined, [])).toBeUndefined();
  });
});

describe("WorkingTreeTouchedBaseIds", () => {
  const BASE = [
    { id: "a1", payload: { relativePath: "src/a.ts" } },
    { id: "a2", payload: { relativePath: "src/a.ts" } },
    { id: "b1", payload: { relativePath: "src/b.ts" } },
    { id: "c1", payload: { relativePath: "src/c.ts" } },
  ];
  /** A Qdrant that answers each scroll with the rows its filter admits, as the server does. */
  const qdrantHolding = () => ({
    scrollFiltered: vi.fn(async (_collection: string, filter: Record<string, unknown>) =>
      BASE.filter((point) => payloadMatchesFilter(point.payload, filter)),
    ),
  });

  it("should resolve the base point ids of exactly the touched paths", async () => {
    const qdrant = qdrantHolding();
    const ids = new WorkingTreeTouchedBaseIds(qdrant);

    const resolved = await ids.idsOf("c", new Set(["src/a.ts", "src/b.ts", "src/new.ts"]), "rev-1");

    expect([...resolved].sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("should not query again for the same collection, touched set and revision", async () => {
    const qdrant = qdrantHolding();
    const ids = new WorkingTreeTouchedBaseIds(qdrant);

    await ids.idsOf("c", new Set(["src/a.ts", "src/b.ts"]), "rev-1");
    const calls = qdrant.scrollFiltered.mock.calls.length;
    await ids.idsOf("c", new Set(["src/b.ts", "src/a.ts"]), "rev-1");

    expect(qdrant.scrollFiltered.mock.calls.length).toBe(calls);
  });

  it("should resolve again when the index revision or the touched set moves, or the entry ages out", async () => {
    const qdrant = qdrantHolding();
    let clock = 0;
    const ids = new WorkingTreeTouchedBaseIds(qdrant, () => clock);

    await ids.idsOf("c", new Set(["src/a.ts"]), "rev-1");
    const afterFirst = qdrant.scrollFiltered.mock.calls.length;
    await ids.idsOf("c", new Set(["src/a.ts"]), "rev-2");
    const afterRevision = qdrant.scrollFiltered.mock.calls.length;
    await ids.idsOf("c", new Set(["src/a.ts", "src/c.ts"]), "rev-2");
    const afterSet = qdrant.scrollFiltered.mock.calls.length;
    clock += 10 * 60_000;
    await ids.idsOf("c", new Set(["src/a.ts", "src/c.ts"]), "rev-2");

    expect(afterRevision).toBeGreaterThan(afterFirst);
    expect(afterSet).toBeGreaterThan(afterRevision);
    expect(qdrant.scrollFiltered.mock.calls.length).toBeGreaterThan(afterSet);
  });

  it("should answer an empty touched set without a query", async () => {
    const qdrant = qdrantHolding();

    expect(await new WorkingTreeTouchedBaseIds(qdrant).idsOf("c", new Set(), "rev-1")).toEqual([]);
    expect(qdrant.scrollFiltered).not.toHaveBeenCalled();
  });

  it("should not keep a failed resolution, so the next query retries", async () => {
    const qdrant = qdrantHolding();
    qdrant.scrollFiltered.mockRejectedValueOnce(new Error("qdrant down"));
    const ids = new WorkingTreeTouchedBaseIds(qdrant);

    await expect(ids.idsOf("c", new Set(["src/a.ts"]), "rev-1")).rejects.toThrow("qdrant down");
    expect([...(await ids.idsOf("c", new Set(["src/a.ts"]), "rev-1"))].sort()).toEqual(["a1", "a2"]);
  });
});
