/**
 * Split / merge verdicts over the temporal co-change sub-graph (A5, bd
 * tea-rags-mcp-c3v6o): does the architecture report's component partition
 * match the partition history votes for?
 *
 * Invariants under test:
 *   - MERGE judges COMPONENT-level bundle counts — support(A,B) is bundles
 *     touching both components (once per bundle, however many files of each it
 *     holds), changes(A) bundles touching A at all — never the capped pair
 *     table;
 *   - the strength of a component pair is `cochangeStrength` over the
 *     synthetic edge {support, support/changesA, support/changesB} — the
 *     Wilson lower bound, so 30/32 outranks 2/2;
 *   - SPLIT clusters a component's internal stored pairs over the SAME drawn
 *     threshold (one population, one draw) and reports a candidate only at
 *     ≥ 2 clusters with the largest weight share under cohesion's 0.7 cut;
 *   - an empty bundle membership map yields empty verdicts, never zeros
 *     posing as verdicts — exclusions of read pairs still count.
 */

import { describe, expect, it } from "vitest";

import type { RelPath, TemporalCochangeEdge } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  cochangeStrength,
  computeSplitMergeVerdicts,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

function componentOf(entries: readonly (readonly [RelPath, string])[]): ReadonlyMap<RelPath, string> {
  return new Map(entries);
}

function pair(a: string, b: string, support: number, changesA: number, changesB: number): TemporalCochangeEdge {
  return {
    relPathA: a,
    relPathB: b,
    support,
    confidenceAB: support / changesA,
    confidenceBA: support / changesB,
    lift: 2,
    lastCoChangeAt: 0,
    sampleCommits: [],
  };
}

/** Bundle id = index, exactly what the store persists. */
function bundleMap(...filesPerBundle: readonly (readonly string[])[]): ReadonlyMap<number, readonly RelPath[]> {
  return new Map(filesPerBundle.map((files, id) => [id, files] as const));
}

describe("computeSplitMergeVerdicts (bd tea-rags-mcp-c3v6o)", () => {
  it("merges two components whose admitted bundles make them change as one unit", () => {
    // 30 bundles touch every file of alpha AND beta; 2 more touch alpha alone.
    // A bundle touching two alpha files still counts once for alpha — the
    // component-level count the pair table cannot answer.
    const bundles = bundleMap(
      ...Array.from({ length: 30 }, () => ["alpha/a1.ts", "alpha/a2.ts", "beta/b1.ts", "beta/b2.ts"]),
      ["alpha/a1.ts", "alpha/a2.ts"],
      ["alpha/a1.ts", "alpha/a2.ts"],
    );
    const verdicts = computeSplitMergeVerdicts({
      components: {
        componentOf: componentOf([
          ["alpha/a1.ts", "alpha"],
          ["alpha/a2.ts", "alpha"],
          ["beta/b1.ts", "beta"],
          ["beta/b2.ts", "beta"],
        ]),
      },
      edges: [
        pair("alpha/a1.ts", "alpha/a2.ts", 30, 32, 32),
        pair("beta/b1.ts", "beta/b2.ts", 30, 30, 30),
        // A stored cross-component pair: MERGE judges component overlap from
        // the bundles, never from the capped pair table.
        pair("alpha/a1.ts", "beta/b1.ts", 30, 32, 30),
      ],
      bundles,
    });

    expect(verdicts.mergeCandidates).toEqual([
      {
        componentA: "alpha",
        componentB: "beta",
        support: 30,
        strength: cochangeStrength({ support: 30, confidenceAB: 30 / 32, confidenceBA: 1 }),
        changesA: 32,
        changesB: 30,
      },
    ]);
    expect(verdicts.splitCandidates).toEqual([]);
    expect(verdicts.threshold).toBe(0.5);
    expect(verdicts.thresholdMethod).toBe("majority");
    expect(verdicts.excluded).toEqual({ unpartitionedEndpoints: 0, crossComponentPairs: 1 });
  });

  it("splits a component whose internal pairs form two clusters neither dominating", () => {
    // Two co-change groups inside one component, joined by one weak bridge:
    // the bridge's Wilson strength (support 2) stays under the floor, so the
    // clustering keeps the groups apart and neither holds 0.7 of the weight.
    const bundles = bundleMap(
      ...Array.from({ length: 16 }, () => ["wide/x1.ts", "wide/x2.ts"]),
      ...Array.from({ length: 20 }, () => ["wide/y1.ts", "wide/y2.ts"]),
      ["wide/x2.ts", "wide/y1.ts"],
      ["wide/x2.ts", "wide/y1.ts"],
    );
    const strongX = cochangeStrength({ support: 16, confidenceAB: 1, confidenceBA: 16 / 18 });
    const strongY = cochangeStrength({ support: 20, confidenceAB: 1, confidenceBA: 20 / 22 });
    const verdicts = computeSplitMergeVerdicts({
      components: {
        componentOf: componentOf([
          ["wide/x1.ts", "wide"],
          ["wide/x2.ts", "wide"],
          ["wide/y1.ts", "wide"],
          ["wide/y2.ts", "wide"],
        ]),
      },
      edges: [
        pair("wide/x1.ts", "wide/x2.ts", 16, 16, 18),
        pair("wide/y1.ts", "wide/y2.ts", 20, 22, 20),
        pair("wide/x2.ts", "wide/y1.ts", 2, 18, 22),
      ],
      bundles,
    });

    expect(verdicts.splitCandidates).toEqual([
      {
        component: "wide",
        clusters: 2,
        largestWeightShare: strongY / (strongY + strongX),
        // Heaviest cluster first, files code-point ordered inside each.
        files: [
          ["wide/y1.ts", "wide/y2.ts"],
          ["wide/x1.ts", "wide/x2.ts"],
        ],
      },
    ]);
    // One component only — nothing to merge; the bridge is internal, judged
    // and refused, not excluded.
    expect(verdicts.mergeCandidates).toEqual([]);
    expect(verdicts.excluded).toEqual({ unpartitionedEndpoints: 0, crossComponentPairs: 0 });
  });

  it("reports no split for a component whose pairs hang together", () => {
    const verdicts = computeSplitMergeVerdicts({
      components: {
        componentOf: componentOf([
          ["solid/s1.ts", "solid"],
          ["solid/s2.ts", "solid"],
          ["solid/s3.ts", "solid"],
        ]),
      },
      edges: [pair("solid/s1.ts", "solid/s2.ts", 20, 20, 20), pair("solid/s2.ts", "solid/s3.ts", 20, 20, 20)],
      bundles: bundleMap(...Array.from({ length: 20 }, () => ["solid/s1.ts", "solid/s2.ts", "solid/s3.ts"])),
    });

    expect(verdicts.splitCandidates).toEqual([]);
    expect(verdicts.mergeCandidates).toEqual([]);
    expect(verdicts.thresholdMethod).toBe("majority");
  });

  it("returns empty verdicts over an empty bundle membership, exclusions still counted", () => {
    const verdicts = computeSplitMergeVerdicts({
      components: {
        componentOf: componentOf([
          ["alpha/a1.ts", "alpha"],
          ["beta/b1.ts", "beta"],
        ]),
      },
      edges: [
        // a2.ts belongs to no component of the partition.
        pair("alpha/a1.ts", "alpha/a2.ts", 30, 32, 32),
        pair("alpha/a1.ts", "beta/b1.ts", 30, 32, 30),
      ],
      bundles: new Map(),
    });

    expect(verdicts).toEqual({
      splitCandidates: [],
      mergeCandidates: [],
      threshold: 0.5,
      thresholdMethod: "majority",
      excluded: { unpartitionedEndpoints: 1, crossComponentPairs: 1 },
    });
  });

  it("ranks by the Wilson lower bound, not the raw rate: 30/32 outranks 2/2", () => {
    // gamma and delta change together twice out of two bundles each — a raw
    // rate of 1.0 that would top any rate-ordered list. The Wilson bound
    // (≈0.34 on two observations) keeps the pair under the majority floor
    // while alpha/beta at 30/32 clears it.
    const bundles = bundleMap(
      ...Array.from({ length: 30 }, () => ["alpha/a1.ts", "alpha/a2.ts", "beta/b1.ts", "beta/b2.ts"]),
      ["alpha/a1.ts", "alpha/a2.ts"],
      ["alpha/a1.ts", "alpha/a2.ts"],
      ["gamma/g1.ts", "delta/d1.ts"],
      ["gamma/g1.ts", "delta/d1.ts"],
    );
    const verdicts = computeSplitMergeVerdicts({
      components: {
        componentOf: componentOf([
          ["alpha/a1.ts", "alpha"],
          ["alpha/a2.ts", "alpha"],
          ["beta/b1.ts", "beta"],
          ["beta/b2.ts", "beta"],
          ["gamma/g1.ts", "gamma"],
          ["delta/d1.ts", "delta"],
        ]),
      },
      edges: [],
      bundles,
    });

    expect(verdicts.mergeCandidates.find((c) => c.componentA === "gamma")).toBeUndefined();
    const alphaBeta = verdicts.mergeCandidates.find((c) => c.componentA === "alpha");
    expect(alphaBeta).toBeDefined();
    expect(alphaBeta?.strength).toBe(cochangeStrength({ support: 30, confidenceAB: 30 / 32, confidenceBA: 1 }));
  });
});
