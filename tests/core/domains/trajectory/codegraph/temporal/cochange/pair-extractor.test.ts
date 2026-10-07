/**
 * The co-change pair extractor (bd tea-rags-mcp-x4rpp): association rules over
 * admitted commit bundles.
 *
 * Invariants under test:
 *   - N (the rule universe) is the ADMITTED bundles, single-file ones included —
 *     a file changing alone is evidence against every rule on it;
 *   - a bundle above `maxFilesPerBundle` contributes nothing, not even counts;
 *   - support / both directed confidences / lift follow their definitions;
 *   - pairs under `minSupport` are not stored;
 *   - the per-file cap keeps an edge iff it ranks in the top N of EITHER endpoint;
 *   - samples are the newest bundles' newest SHAs, at most three.
 */

import { describe, expect, it } from "vitest";

import {
  extractCochangeGraph,
  type CochangeBundle,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

let nextBurst = 0;

/** A commit bundle that is its own author burst unless `burst` says otherwise. */
function bundle(sha: string, timestamp: number, files: string[], burst = 1_000_000 + nextBurst++): CochangeBundle {
  return { shas: [sha], timestamp, files, burst };
}

const OPTIONS = { minSupport: 2, maxPartnersPerFile: 20, maxFilesPerBundle: 10 };

describe("extractCochangeGraph", () => {
  it("computes support, directed confidence and lift over the admitted universe", () => {
    const bundles = [
      bundle("s1", 1, ["a.ts", "b.ts"]),
      bundle("s2", 2, ["a.ts", "b.ts"]),
      bundle("s3", 3, ["a.ts"]),
      bundle("s4", 4, ["c.ts"]),
    ];

    const graph = extractCochangeGraph(bundles, OPTIONS);

    expect(graph.admittedBundleCount).toBe(4);
    expect(graph.edges).toEqual([
      {
        relPathA: "a.ts",
        relPathB: "b.ts",
        support: 2,
        confidenceAB: 2 / 3,
        confidenceBA: 1,
        lift: (2 * 4) / (3 * 2),
        lastCoChangeAt: 2,
        sampleCommits: ["s2", "s1"],
      },
    ]);
    expect(graph.files).toEqual([
      { relPath: "a.ts", bundleCount: 3, partnerCount: 1, lastChangedAt: 3 },
      { relPath: "b.ts", bundleCount: 2, partnerCount: 1, lastChangedAt: 2 },
      { relPath: "c.ts", bundleCount: 1, partnerCount: 0, lastChangedAt: 4 },
    ]);
  });

  it("drops a bundle above the mass-change cut entirely", () => {
    const wide = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
    const graph = extractCochangeGraph(
      [bundle("s1", 1, ["a.ts", "b.ts"]), bundle("s2", 2, ["a.ts", "b.ts"]), bundle("mass", 3, [...wide, "a.ts"])],
      OPTIONS,
    );

    expect(graph.admittedBundleCount).toBe(2);
    expect(graph.files.map((f) => f.relPath)).toEqual(["a.ts", "b.ts"]);
    expect(graph.edges[0].confidenceAB).toBe(1);
  });

  it("stores no pair below the support floor", () => {
    const graph = extractCochangeGraph([bundle("s1", 1, ["a.ts", "b.ts"]), bundle("s2", 2, ["a.ts"])], OPTIONS);

    expect(graph.edges).toEqual([]);
    expect(graph.files.every((f) => f.partnerCount === 0)).toBe(true);
  });

  it("keeps an edge in the top N of either endpoint and drops one in neither", () => {
    // hub.ts co-changes with p1..p3; with a cap of 1 the hub keeps only its
    // strongest partner, but each partner's own top-1 is the hub — so all stay.
    // q.ts ranks second for both hub2.ts and r.ts and survives in neither.
    const bundles = [
      ...[1, 2, 3].map((t) => bundle(`h1-${t}`, t, ["hub.ts", "p1.ts"])),
      ...[4, 5].map((t) => bundle(`h2-${t}`, t, ["hub.ts", "p2.ts"])),
      ...[6, 7].map((t) => bundle(`h3-${t}`, t, ["hub.ts", "p3.ts"])),
      ...[8, 9, 10].map((t) => bundle(`x-${t}`, t, ["hub2.ts", "r.ts"])),
      ...[11, 12].map((t) => bundle(`y-${t}`, t, ["hub2.ts", "r.ts", "q.ts"])),
      ...[13, 14, 15, 16].map((t) => bundle(`z-${t}`, t, ["q.ts", "w.ts"])),
    ];

    const graph = extractCochangeGraph(bundles, { ...OPTIONS, maxPartnersPerFile: 1 });
    const kept = graph.edges.map((e) => `${e.relPathA}|${e.relPathB}`);

    expect(kept).toContain("hub.ts|p1.ts");
    expect(kept).toContain("hub.ts|p2.ts");
    expect(kept).toContain("hub.ts|p3.ts");
    expect(kept).toContain("hub2.ts|r.ts");
    expect(kept).toContain("q.ts|w.ts");
    expect(kept).not.toContain("hub2.ts|q.ts");
    expect(kept).not.toContain("q.ts|r.ts");
  });

  it("samples at most three SHAs, newest bundle first, each bundle's newest member", () => {
    const bundles: CochangeBundle[] = [1, 2, 3, 4].map((t) => ({
      shas: [`old-${t}`, `new-${t}`],
      timestamp: t,
      files: ["a.ts", "b.ts"],
      burst: t,
    }));

    const [edge] = extractCochangeGraph(bundles, OPTIONS).edges;

    expect(edge.sampleCommits).toEqual(["new-4", "new-3", "new-2"]);
    expect(edge.lastCoChangeAt).toBe(4);
  });

  it("orders each pair and the edge list by code point", () => {
    const graph = extractCochangeGraph(
      [bundle("s1", 1, ["z.ts", "B.ts", "a.ts"]), bundle("s2", 2, ["a.ts", "z.ts", "B.ts"])],
      OPTIONS,
    );

    expect(graph.edges.map((e) => [e.relPathA, e.relPathB])).toEqual([
      ["B.ts", "a.ts"],
      ["B.ts", "z.ts"],
      ["a.ts", "z.ts"],
    ]);
  });

  it("returns the admitted bundles' file memberships in extraction order, mass-commit bundles absent", () => {
    const wide = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
    const graph = extractCochangeGraph(
      [bundle("s1", 1, ["a.ts", "b.ts"]), bundle("mass", 2, [...wide, "a.ts"]), bundle("s3", 3, ["c.ts"])],
      OPTIONS,
    );

    // Extraction order is newest admitted bundle first; single-file bundles
    // count — a file changing alone is evidence against every rule on it.
    expect(graph.admittedBundles).toEqual([["c.ts"], ["a.ts", "b.ts"]]);
  });

  describe("author-burst dedup (bd tea-rags-mcp-3vg0x)", () => {
    it("counts a pair re-committed five times inside one burst once", () => {
      const burst = [1, 2, 3, 4, 5].map((t) => bundle(`w${t}`, t, ["a.ts", "b.ts"], 7));
      const graph = extractCochangeGraph([...burst, bundle("o1", 10, ["a.ts", "b.ts"], 8)], {
        ...OPTIONS,
        minSupport: 1,
      });

      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].support).toBe(2);
      expect(extractCochangeGraph(burst, { ...OPTIONS, minSupport: 1 }).edges[0].support).toBe(1);
    });

    it("counts the same pair in two separate bursts twice", () => {
      const graph = extractCochangeGraph(
        [
          ...[1, 2, 3].map((t) => bundle(`p${t}`, t, ["a.ts", "b.ts"], 1)),
          ...[11, 12].map((t) => bundle(`q${t}`, t, ["a.ts", "b.ts"], 2)),
        ],
        OPTIONS,
      );

      expect(graph.edges.map((e) => e.support)).toEqual([2]);
    });

    it("counts a file once per burst and measures N in bursts, so confidence and lift stay rates", () => {
      // Burst 1: a~b, then a alone. Burst 2: a~b. Burst 3: c alone.
      const graph = extractCochangeGraph(
        [
          bundle("s1", 1, ["a.ts", "b.ts"], 1),
          bundle("s2", 2, ["a.ts"], 1),
          bundle("s3", 3, ["a.ts", "b.ts"], 2),
          bundle("s4", 4, ["c.ts"], 3),
        ],
        OPTIONS,
      );

      expect(graph.admittedBundleCount).toBe(4);
      expect(graph.admittedBurstCount).toBe(3);
      expect(graph.edges[0]).toMatchObject({ support: 2, confidenceAB: 1, confidenceBA: 1, lift: (2 * 3) / (2 * 2) });
      expect(graph.files.map((f) => [f.relPath, f.bundleCount])).toEqual([
        ["a.ts", 2],
        ["b.ts", 2],
        ["c.ts", 1],
      ]);
    });

    it("never pairs two files that only met across a burst's different commits", () => {
      const graph = extractCochangeGraph(
        [1, 2].flatMap((b) => [bundle(`x${b}`, b * 10, ["x.ts"], b), bundle(`y${b}`, b * 10 + 1, ["y.ts"], b)]),
        OPTIONS,
      );

      expect(graph.edges).toEqual([]);
    });

    it("samples one commit per burst, newest burst first", () => {
      const graph = extractCochangeGraph(
        [
          bundle("b1-old", 1, ["a.ts", "b.ts"], 1),
          bundle("b1-new", 2, ["a.ts", "b.ts"], 1),
          bundle("b2-only", 5, ["a.ts", "b.ts"], 2),
        ],
        OPTIONS,
      );

      expect(graph.edges[0].sampleCommits).toEqual(["b2-only", "b1-new"]);
    });

    it("returns each admitted bundle's burst, aligned with the memberships and numbered densely", () => {
      const graph = extractCochangeGraph(
        [bundle("s1", 1, ["a.ts", "b.ts"], 40), bundle("s2", 2, ["a.ts"], 40), bundle("s3", 3, ["c.ts"], 90)],
        OPTIONS,
      );

      expect(graph.admittedBundleCommits).toEqual([["s3"], ["s2"], ["s1"]]);
      expect(graph.admittedBundleBursts).toEqual([0, 1, 1]);
    });
  });
});
