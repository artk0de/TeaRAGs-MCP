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
 *   (5–8 ms), the ids read by `WorkingTreeTouchedBasePoints` (its own spec).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as sparse from "../../../../../src/core/adapters/qdrant/sparse.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import {
  excludeWorkingTreeBaseIds,
  scoreWorkingTreeRows,
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
