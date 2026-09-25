/**
 * Silent coupling (A2, bd tea-rags-mcp-b4dcz): file pairs that co-change
 * strongly while no call, import or re-export joins them.
 *
 * Invariants under test:
 *   - strength = the larger direction's 95% Wilson lower bound on the
 *     conditional co-change rate; "strong" = at or above Otsu's cut over every
 *     candidate AND strictly above 0.5, the 0.5 floor alone below 8 candidates;
 *   - only an UNLINKED strong pair is a violation, with its evidence;
 *   - tests, generated code, documentation, pairs with no walked endpoint,
 *     pairs with a no-symbol walked endpoint and pairs with lift ≤ 1 are
 *     excluded and counted, by the first reason that applies;
 *   - a file with two or more silent partners is a root cause;
 *   - `pathPattern` scopes the judged pairs by either endpoint, never the cut;
 *   - no build is reported as not built, not as a clean bill of health.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyGraphFile,
  TemporalCochangeBuildMeta,
  TemporalCochangeEdgeWithLinkage,
  TemporalCochangeGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  detectSilentCoupling,
  SILENT_COUPLING_STRENGTH_MAJORITY,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

const META: TemporalCochangeBuildMeta = {
  head: "abc123",
  fingerprint: "fp",
  builtAt: 1_700_000_100,
  windowSince: 1_690_000_000,
  commitCount: 200,
  bundleCount: 180,
  admittedBundleCount: 170,
  maxFilesPerBundle: 20,
  minSupport: 2,
  maxPartnersPerFile: 20,
  sessionGapMinutes: null,
};

/** Wilson lower bound (z = 1.96) of 10 successes out of 10 trials. */
const WILSON_10_OF_10 = 1 / (1 + 1.96 ** 2 / 10);
/** Wilson lower bound (z = 1.96) of 5 successes out of 5 trials. */
const WILSON_5_OF_5 = 1 / (1 + 1.96 ** 2 / 5);

function pair(
  relPathA: string,
  relPathB: string,
  overrides: Partial<TemporalCochangeEdgeWithLinkage> = {},
): TemporalCochangeEdgeWithLinkage {
  return {
    relPathA,
    relPathB,
    support: 10,
    confidenceAB: 1,
    confidenceBA: 1,
    lift: 5,
    lastCoChangeAt: 1_700_000_000,
    sampleCommits: ["c3", "c2", "c1"],
    structurallyLinked: false,
    ...overrides,
  };
}

function files(...relPaths: string[]): FileDependencyGraphFile[] {
  return relPaths.map((relPath) => ({ relPath, language: "typescript", symbolCount: 1 }));
}

function built(edges: TemporalCochangeEdgeWithLinkage[]): TemporalCochangeGraph {
  return { meta: META, edges };
}

describe("detectSilentCoupling", () => {
  it("reports a strong unlinked pair with its evidence and leaves a strong linked one alone", () => {
    const report = detectSilentCoupling(
      built([
        pair("src/a.ts", "src/b.ts"),
        pair("src/a.ts", "src/c.ts", { structurallyLinked: true }),
        pair("lib/d.ts", "src/a.ts", { support: 2, confidenceAB: 0.2, confidenceBA: 0.2 }),
      ]),
      files("src/a.ts", "src/b.ts", "src/c.ts", "lib/d.ts"),
    );

    expect(report.violations).toHaveLength(1);
    const [v] = report.violations;
    expect(v).toMatchObject({
      relPathA: "src/a.ts",
      relPathB: "src/b.ts",
      support: 10,
      confidenceAB: 1,
      confidenceBA: 1,
      lift: 5,
      lastCoChangeAt: 1_700_000_000,
      sampleCommits: ["c3", "c2", "c1"],
      structuralVisibility: "both-walked",
      directoryRelation: "same",
    });
    expect(v.strength).toBeCloseTo(WILSON_10_OF_10, 12);
    expect(report.summary).toMatchObject({
      built: true,
      pairCount: 3,
      candidateCount: 3,
      strongCount: 2,
      strongLinkedCount: 1,
      violationCount: 1,
      strengthThreshold: SILENT_COUPLING_STRENGTH_MAJORITY,
      strengthThresholdMethod: "majority",
    });
    expect(report.summary.strengthSeparability).toBeUndefined();
    expect(report.summary.build).toMatchObject({ head: "abc123", commitCount: 200, sessionGapMinutes: null });
  });

  it("takes the stronger direction: a rare file that always drags a busy one along is strongly coupled", () => {
    // A changed 40 times, B 10 times, together 10: P(A|B) = 1 carries it.
    const report = detectSilentCoupling(
      built([pair("src/a.ts", "src/b.ts", { confidenceAB: 0.25, confidenceBA: 1 })]),
      files("src/a.ts", "src/b.ts"),
    );

    expect(report.violations[0]?.strength).toBeCloseTo(WILSON_10_OF_10, 12);
  });

  it("raises the cut to Otsu's split over the candidates when there are enough of them", () => {
    const edges = [
      ...["p1", "p2", "p3", "p4"].map((p) => pair("src/hub.ts", `src/${p}.ts`)),
      ...["q1", "q2", "q3", "q4"].map((q) => pair(`lib/${q}.ts`, "src/other.ts", { support: 5 })),
    ];
    const report = detectSilentCoupling(
      built(edges),
      files(
        "src/hub.ts",
        "src/other.ts",
        ...["p1", "p2", "p3", "p4"].map((p) => `src/${p}.ts`),
        "lib/q1.ts",
        "lib/q2.ts",
        "lib/q3.ts",
        "lib/q4.ts",
      ),
    );

    expect(report.summary.strengthThresholdMethod).toBe("otsu");
    expect(report.summary.strengthThreshold).toBeCloseTo((WILSON_5_OF_5 + WILSON_10_OF_10) / 2, 12);
    expect(report.summary.strengthSeparability).toBeCloseTo(1, 12);
    // 5-of-5 pairs clear the 0.5 floor but not the corpus's own cut.
    expect(WILSON_5_OF_5).toBeGreaterThan(0.5);
    expect(report.violations.map((v) => v.relPathB)).toEqual(["src/p1.ts", "src/p2.ts", "src/p3.ts", "src/p4.ts"]);
    expect(report.rootCauses).toEqual([
      {
        relPath: "src/hub.ts",
        violationCount: 4,
        maxStrength: expect.closeTo(WILSON_10_OF_10, 12),
        partners: ["src/p1.ts", "src/p2.ts", "src/p3.ts", "src/p4.ts"],
      },
    ]);
  });

  it("excludes and counts pairs by the first reason that applies", () => {
    const report = detectSilentCoupling(
      built([
        pair("src/a.ts", "tests/a.test.ts"),
        pair("src/a.ts", "src/api.generated.ts"),
        pair("README.md", "src/a.ts"),
        pair("config/a.yml", "config/b.yml"),
        pair("src/a.ts", "src/types.ts"),
        pair("src/a.ts", "src/b.ts", { lift: 1 }),
      ]),
      [
        ...files("src/a.ts", "src/b.ts", "src/api.generated.ts"),
        { relPath: "src/types.ts", language: "typescript", symbolCount: 0 },
      ],
      { isDocumentation: (relPath) => relPath.endsWith(".md") },
    );

    expect(report.violations).toEqual([]);
    expect(report.summary.excluded).toEqual({
      testEndpoints: 1,
      generatedEndpoints: 1,
      documentationEndpoints: 1,
      unwalkedEndpoints: 1,
      noSymbolEndpoints: 1,
      nonPositiveLift: 1,
    });
    expect(report.summary.candidateCount).toBe(0);
  });

  it("keeps a pair whose other endpoint is not walked code, and says the graph cannot see it", () => {
    const report = detectSilentCoupling(built([pair("config/corpora.json", "src/a.ts")]), files("src/a.ts"));

    expect(report.violations[0]).toMatchObject({
      relPathA: "config/corpora.json",
      structuralVisibility: "one-walked",
      directoryRelation: "disjoint",
    });
  });

  it("scopes the judged pairs by either endpoint while the cut is drawn over all of them", () => {
    const report = detectSilentCoupling(
      built([pair("app/x.ts", "lib/y.ts"), pair("lib/y.ts", "web/z.ts"), pair("lib/k.ts", "lib/m.ts")]),
      files("app/x.ts", "lib/y.ts", "web/z.ts", "lib/k.ts", "lib/m.ts"),
      { sourcePathPattern: "{app,web}/**" },
    );

    expect(report.violations.map((v) => `${v.relPathA}|${v.relPathB}`)).toEqual([
      "app/x.ts|lib/y.ts",
      "lib/y.ts|web/z.ts",
    ]);
    expect(report.summary.candidateCount).toBe(3);
    expect(report.summary.scope).toEqual({ sourcePathPattern: "{app,web}/**", outOfScopePairCount: 1 });
    expect(report.rootCauses).toEqual([
      {
        relPath: "lib/y.ts",
        violationCount: 2,
        maxStrength: expect.closeTo(WILSON_10_OF_10, 12),
        partners: ["app/x.ts", "web/z.ts"],
      },
    ]);
  });

  it("reports no build as not built", () => {
    const report = detectSilentCoupling({ meta: null, edges: [] }, files("src/a.ts"));

    expect(report.violations).toEqual([]);
    expect(report.rootCauses).toEqual([]);
    expect(report.summary.built).toBe(false);
    expect(report.summary.build).toBeUndefined();
    expect(report.summary.pairCount).toBe(0);
  });
});
