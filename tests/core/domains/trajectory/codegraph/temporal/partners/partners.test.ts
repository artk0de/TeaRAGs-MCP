/**
 * `rankCochangePartners` (bd tea-rags-mcp-l1ot.1) — the read side of the
 * temporal co-change sub-graph: one queried file's stored partners, each
 * normalized to the queried file's perspective and ranked by Wilson
 * lower-bound strength.
 *
 * Invariants under test:
 *   - direction normalization: the stored pair is undirected
 *     (`relPathA < relPathB`); the answer flips confidence to
 *     P(partner|file) / P(file|partner) whichever side the queried file was;
 *   - ordering: strength desc, support desc, relPath asc as the final
 *     deterministic tiebreak;
 *   - `limit` truncates after ordering;
 *   - a file with no stored partner answers `inGraph: false`, never an error;
 *   - a partner whose path fails the injected liveness predicate is dropped
 *     BEFORE the limit — a deleted file never resurfaces as a partner
 *     (owner acceptance on tea-rags-mcp-l1ot.1);
 *   - `structurallyLinked` passes through untouched (the SQL linkage verdict
 *     of the store's `readGraph`, not recomputed here).
 */
import { describe, expect, it } from "vitest";

import type {
  TemporalCochangeEdgeWithLinkage,
  TemporalCochangeGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { cochangeStrength } from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/boundary-diagnostics/index.js";
import { rankCochangePartners } from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/partners/index.js";

function edge(
  relPathA: string,
  relPathB: string,
  overrides: Partial<TemporalCochangeEdgeWithLinkage> = {},
): TemporalCochangeEdgeWithLinkage {
  return {
    relPathA,
    relPathB,
    support: 3,
    confidenceAB: 0.75,
    confidenceBA: 0.5,
    lift: 4.5,
    lastCoChangeAt: 1_700_000_000,
    sampleCommits: ["s3", "s2", "s1"],
    structurallyLinked: false,
    ...overrides,
  };
}

function graph(edges: TemporalCochangeEdgeWithLinkage[]): TemporalCochangeGraph {
  return { meta: null, edges };
}

describe("rankCochangePartners", () => {
  it("normalizes an edge stored the other way round to the queried file's perspective", () => {
    // Stored a.ts < src/other.ts; the query names the B side.
    const result = rankCochangePartners(graph([edge("a.ts", "src/other.ts")]), ["src/other.ts"], 10);

    expect(result).toHaveLength(1);
    expect(result[0].inGraph).toBe(true);
    expect(result[0].partners).toEqual([
      {
        relPath: "a.ts",
        support: 3,
        pPartnerGivenFile: 0.5, // confidenceBA — P(a.ts changes | src/other.ts changes)
        pFileGivenPartner: 0.75, // confidenceAB — P(src/other.ts changes | a.ts changes)
        strength: cochangeStrength(edge("a.ts", "src/other.ts")),
        lift: 4.5,
        lastCoChangeAt: 1_700_000_000,
        sampleCommits: ["s3", "s2", "s1"],
        structurallyLinked: false,
      },
    ]);
  });

  it("ranks by strength desc, then support desc, then relPath asc", () => {
    const edges = [
      // Same confidence shape, different support → higher support is stronger.
      edge("weak.ts", "target.ts", { support: 2, confidenceAB: 0.1, confidenceBA: 0.1, lift: 1.2 }),
      edge("zeta.ts", "target.ts", { support: 8, confidenceAB: 0.4, confidenceBA: 0.4, lift: 2.5 }),
      // Ties with zeta on support and confidence → relPath asc puts alpha first.
      edge("alpha.ts", "target.ts", { support: 8, confidenceAB: 0.4, confidenceBA: 0.4, lift: 2.5 }),
    ];
    const result = rankCochangePartners(graph(edges), ["target.ts"], 10);

    expect(result[0].partners.map((p) => p.relPath)).toEqual(["alpha.ts", "zeta.ts", "weak.ts"]);
  });

  it("truncates after ordering, not before", () => {
    const edges = [
      edge("strong.ts", "target.ts", { support: 9 }),
      edge("mild.ts", "target.ts", { support: 4 }),
      edge("weak.ts", "target.ts", { support: 2 }),
    ];
    const result = rankCochangePartners(graph(edges), ["target.ts"], 2);

    expect(result[0].partners.map((p) => p.relPath)).toEqual(["strong.ts", "mild.ts"]);
  });

  it("answers a file with no stored partner as inGraph:false with no partners, not an error", () => {
    const result = rankCochangePartners(graph([edge("a.ts", "b.ts")]), ["stranger.ts"], 10);

    expect(result).toEqual([{ relPath: "stranger.ts", inGraph: false, partners: [] }]);
  });

  it("answers an empty graph (no build) with every queried file inGraph:false", () => {
    const result = rankCochangePartners(graph([]), ["a.ts", "b.ts"], 10);

    expect(result).toEqual([
      { relPath: "a.ts", inGraph: false, partners: [] },
      { relPath: "b.ts", inGraph: false, partners: [] },
    ]);
  });

  it("drops a partner whose path fails the liveness predicate before the limit applies", () => {
    const edges = [
      edge("deleted.ts", "target.ts", { support: 9 }),
      edge("alive.ts", "target.ts", { support: 4 }),
      edge("also-alive.ts", "target.ts", { support: 2 }),
    ];
    const live = new Set(["target.ts", "alive.ts", "also-alive.ts"]);
    const result = rankCochangePartners(graph(edges), ["target.ts"], 2, (relPath) => live.has(relPath));

    expect(result[0].partners.map((p) => p.relPath)).toEqual(["alive.ts", "also-alive.ts"]);
  });

  it("keeps the queried file itself out of its own partner list", () => {
    // A self-pair cannot be stored (the extractor never pairs a file with
    // itself), but the direction normalization must not surface it either way.
    const result = rankCochangePartners(graph([edge("target.ts", "other.ts")]), ["target.ts", "other.ts"], 10);

    expect(result[0].partners.map((p) => p.relPath)).toEqual(["other.ts"]);
    expect(result[1].partners.map((p) => p.relPath)).toEqual(["target.ts"]);
  });

  it("answers several queried files independently, in request order, deduplicated", () => {
    const edges = [edge("a.ts", "b.ts"), edge("b.ts", "c.ts")];
    const result = rankCochangePartners(graph(edges), ["b.ts", "a.ts", "b.ts"], 10);

    expect(result.map((r) => r.relPath)).toEqual(["b.ts", "a.ts"]);
    expect(result[0].partners.map((p) => p.relPath)).toEqual(["a.ts", "c.ts"]);
    expect(result[1].partners.map((p) => p.relPath)).toEqual(["b.ts"]);
  });

  it("passes structurallyLinked through from the store's linkage verdict", () => {
    const result = rankCochangePartners(graph([edge("a.ts", "b.ts", { structurallyLinked: true })]), ["b.ts"], 10);

    expect(result[0].partners[0].structurallyLinked).toBe(true);
  });
});
