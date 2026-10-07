/**
 * Co-change pair significance (bd tea-rags-mcp-89k7k.1.14): the configuration
 * (Chung–Lu) null over admitted bundles, a Poisson upper tail per pair, and
 * Benjamini–Hochberg over an a-priori family.
 *
 * Invariants under test:
 *   - λ_pq = n_p·n_q·Qs/M², Qs = Σ k_b(k_b−1), M = Σ k_b over the history;
 *   - the Poisson tail is exact on small cases and finite/stable on large λ;
 *   - BH rejects the largest k with p_(k) ≤ q·k/m;
 *   - the family size is a-priori: C(|F₂|,2) repo-wide, |D*|(|F₂|−1) − C(|D*|,2)
 *     for a review — never the count of observed pairs;
 *   - a pair with support < 2 is never admitted, even when BH rejects it;
 *   - a hub in every bundle is not admitted, a pair over-co-changing is;
 *   - an exchangeable (structure-free) design admits nothing;
 *   - in a review, bundles made of the diff's own commits leave the history.
 */
import { describe, expect, it } from "vitest";

import type { TemporalCochangeGraph } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  assessCochangeSignificance,
  assessGraphCochangeSignificance,
  benjaminiHochbergRejectionCount,
  COCHANGE_SIGNIFICANCE_FDR_Q,
  configurationNullRate,
  fullCochangeFamilySize,
  poissonUpperTail,
  queryCochangeFamilySize,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

describe("configurationNullRate", () => {
  it("is n_p·n_q·Qs/M² over the history's bundle sizes", () => {
    // Bundles {a,b} {a,b,c} {c,d} {a,d}: M = 9, Qs = 2 + 6 + 2 + 2 = 12; n_a = 3, n_b = 2.
    expect(configurationNullRate(3, 2, { membership: 9, pairSlots: 12 })).toBeCloseTo((3 * 2 * 12) / 81, 15);
  });
});

describe("poissonUpperTail", () => {
  it("is 1 at support 0 and 1 − e^−λ at support 1", () => {
    expect(poissonUpperTail(0, 3)).toBe(1);
    expect(poissonUpperTail(1, 0.25)).toBeCloseTo(1 - Math.exp(-0.25), 15);
  });

  it("matches the closed form on a small case", () => {
    // P(X ≥ 3 | λ = 0.5) = 1 − e^−0.5 (1 + 0.5 + 0.125)
    expect(poissonUpperTail(3, 0.5)).toBeCloseTo(1 - Math.exp(-0.5) * 1.625, 14);
  });

  it("is stable for large λ on both sides of the mean", () => {
    const atMean = poissonUpperTail(1000, 1000);
    expect(atMean).toBeGreaterThan(0.5);
    expect(atMean).toBeLessThan(0.52);
    const farTail = poissonUpperTail(1200, 1000);
    expect(Number.isFinite(farTail)).toBe(true);
    expect(farTail).toBeGreaterThan(0);
    expect(farTail).toBeLessThan(1e-8);
    const belowMean = poissonUpperTail(800, 1000);
    expect(belowMean).toBeGreaterThan(0.999_999);
    expect(belowMean).toBeLessThanOrEqual(1);
    // A tiny tail far from the mean is resolved in log space, not rounded to 0.
    expect(poissonUpperTail(60, 1)).toBeGreaterThan(0);
  });

  it("decreases in support", () => {
    let previous = 1;
    for (let s = 1; s <= 30; s++) {
      const p = poissonUpperTail(s, 7.5);
      expect(p).toBeLessThan(previous);
      previous = p;
    }
  });
});

describe("benjaminiHochbergRejectionCount", () => {
  it("rejects the largest k with p_(k) ≤ q·k/m", () => {
    const p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
    expect(benjaminiHochbergRejectionCount(p, 10, 0.05)).toBe(2);
    expect(COCHANGE_SIGNIFICANCE_FDR_Q).toBe(0.05);
  });

  it("counts untested family members in m, so a larger family rejects less", () => {
    const p = [0.001, 0.008];
    expect(benjaminiHochbergRejectionCount(p, 2, 0.05)).toBe(2);
    expect(benjaminiHochbergRejectionCount(p, 1000, 0.05)).toBe(0);
  });
});

describe("family sizes", () => {
  it("is C(|F₂|, 2) repo-wide", () => {
    expect(fullCochangeFamilySize(5)).toBe(10);
    expect(fullCochangeFamilySize(1)).toBe(0);
  });

  it("counts a pair with both ends in the diff once in a review", () => {
    // Pairs touching {d1, d2} among 5 files: C(5,2) − C(3,2) = 7.
    expect(queryCochangeFamilySize(2, 5)).toBe(7);
    expect(queryCochangeFamilySize(0, 5)).toBe(0);
  });
});

/** Every bundle carries the hub; `x`~`y` co-change far beyond their change counts. */
function hubCorpus(): string[][] {
  const bundles: string[][] = [];
  for (let i = 0; i < 40; i++) {
    const first = `src/f${i % 20}.ts`;
    const second = `src/f${(i * 7 + 3) % 20}.ts`;
    bundles.push(first === second ? ["config/locales/en.yml", first] : ["config/locales/en.yml", first, second]);
  }
  for (let i = 0; i < 8; i++) bundles.push(["config/locales/en.yml", "src/x.ts", "src/y.ts"]);
  return bundles;
}

describe("assessCochangeSignificance", () => {
  it("does not admit a key-addressed hub's pairs while admitting a genuinely over-co-changing pair", () => {
    const significance = assessCochangeSignificance(hubCorpus(), { kind: "full" });

    expect(significance.admits("src/x.ts", "src/y.ts")).toBe(true);
    expect(significance.admits("src/y.ts", "src/x.ts")).toBe(true);
    expect(significance.admits("config/locales/en.yml", "src/x.ts")).toBe(false);
    for (let i = 0; i < 20; i++) expect(significance.admits("config/locales/en.yml", `src/f${i}.ts`)).toBe(false);
    expect(significance.summary).toMatchObject({
      method: "poissonConfigurationNull",
      family: "full",
      q: 0.05,
      familySize: fullCochangeFamilySize(23),
    });
    expect(significance.summary.admittedPairCount).toBeGreaterThanOrEqual(1);
  });

  // bd tea-rags-mcp-89k7k.1.14 presentation: a grouped finding shows each
  // partner's support beside the λ the null predicted for it.
  it("answers the configuration null's expected support λ for a pair, either order", () => {
    const bundles = [["src/p.ts", "src/q.ts", "src/r.ts"], ["src/p.ts", "src/q.ts"], ["src/p.ts"]];
    const significance = assessCochangeSignificance(bundles, { kind: "full" });
    // n_p = 3, n_q = 2, M = 3 + 2 + 1 = 6, Qs = 6 + 2 + 0 = 8.
    const lambda = configurationNullRate(3, 2, { membership: 6, pairSlots: 8 });
    expect(significance.expectedSupport("src/p.ts", "src/q.ts")).toBeCloseTo(lambda, 15);
    expect(significance.expectedSupport("src/q.ts", "src/p.ts")).toBeCloseTo(lambda, 15);
  });

  it("admits nothing on an exchangeable design where every pair co-changes equally", () => {
    const filesOf = ["a", "b", "c", "d", "e", "f"].map((n) => `src/${n}.ts`);
    const bundles: string[][] = [];
    for (let i = 0; i < 6; i++) {
      for (let j = i + 1; j < 6; j++) {
        for (let k = j + 1; k < 6; k++) bundles.push([filesOf[i], filesOf[j], filesOf[k]]);
      }
    }

    const significance = assessCochangeSignificance(bundles, { kind: "full" });

    expect(significance.summary.testedPairCount).toBe(15);
    expect(significance.summary.admittedPairCount).toBe(0);
  });

  it("never admits a pair seen together once, even when the test rejects it", () => {
    const bundles: string[][] = [["src/p.ts", "src/q.ts"], ["src/p.ts"], ["src/q.ts"]];
    for (let i = 0; i < 300; i++) bundles.push([`src/u${i}.ts`, `src/v${i}.ts`]);

    const significance = assessCochangeSignificance(bundles, { kind: "full" });

    expect(significance.summary).toMatchObject({ familySize: 1, testedPairCount: 1, admittedPairCount: 0 });
    expect(significance.admits("src/p.ts", "src/q.ts")).toBe(false);
  });

  it("restricts F₂ to paths that exist in the judged tree", () => {
    const significance = assessCochangeSignificance(
      hubCorpus(),
      { kind: "full" },
      { exists: (relPath) => relPath !== "src/f0.ts" },
    );
    expect(significance.summary.familySize).toBe(fullCochangeFamilySize(22));
    expect(significance.admits("config/locales/en.yml", "src/f0.ts")).toBe(false);
  });

  it("sizes a review's family by the diff, not by the pairs it observed", () => {
    const significance = assessCochangeSignificance(hubCorpus(), {
      kind: "query",
      diffFiles: ["src/x.ts", "src/y.ts", "src/never-changed.ts"],
    });

    // D* = {x, y} (never-changed has n < 2), F₂ = 23 files.
    expect(significance.summary).toMatchObject({ family: "query", familySize: queryCochangeFamilySize(2, 23) });
    expect(significance.admits("src/x.ts", "src/y.ts")).toBe(true);
    // A pair with neither end in the diff is outside the family.
    expect(significance.admits("src/f1.ts", "src/f2.ts")).toBe(false);
  });
});

describe("assessGraphCochangeSignificance", () => {
  const graphOf = (bundles: string[][], commits?: string[][]): TemporalCochangeGraph => ({
    meta: null,
    edges: [],
    bundles: new Map(bundles.map((files, id) => [id, files])),
    ...(commits ? { bundleCommits: new Map(commits.map((shas, id) => [id, shas])) } : {}),
  });

  it("is undefined when the read carries no bundle membership", () => {
    expect(assessGraphCochangeSignificance({ meta: null, edges: [] }, { kind: "full" })).toBeUndefined();
  });

  it("drops the diff's own bundles from a review's history so the change cannot confirm itself", () => {
    const bundles = hubCorpus();
    const commits = bundles.map((_, id) => [`sha${id}`]);
    // The 8 x~y bundles are the last 8; make them the diff's commits.
    const diffCommits = commits.slice(-8).map(([sha]) => sha);

    const leaked = assessGraphCochangeSignificance(graphOf(bundles, commits), {
      kind: "query",
      diffFiles: ["src/x.ts"],
    });
    const clean = assessGraphCochangeSignificance(graphOf(bundles, commits), {
      kind: "query",
      diffFiles: ["src/x.ts"],
      diffCommits,
    });

    expect(leaked?.admits("src/x.ts", "src/y.ts")).toBe(true);
    expect(clean?.admits("src/x.ts", "src/y.ts")).toBe(false);
    expect(clean?.summary.diffHistory).toEqual({ excludedBundleCount: 8, bundleCommitsAvailable: true });
  });

  it("says so when the build carries no bundle commits to exclude", () => {
    const significance = assessGraphCochangeSignificance(graphOf(hubCorpus()), {
      kind: "query",
      diffFiles: ["src/x.ts"],
      diffCommits: ["sha1"],
    });
    expect(significance?.summary.diffHistory).toEqual({ excludedBundleCount: 0, bundleCommitsAvailable: false });
  });
});
