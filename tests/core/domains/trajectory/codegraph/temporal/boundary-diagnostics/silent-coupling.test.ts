/**
 * Silent coupling (A2, bd tea-rags-mcp-b4dcz): file pairs that co-change
 * strongly while no call, import or re-export joins them.
 *
 * Invariants under test:
 *   - strength = the larger direction's 95% Wilson lower bound on the
 *     conditional co-change rate; "strong" = at or above Otsu's cut over every
 *     candidate AND strictly above 0.5, the 0.5 floor alone below 8 candidates;
 *   - only an UNLINKED strong pair is a violation, with its evidence;
 *   - tests, generated code, documentation, pairs with no walked endpoint and
 *     pairs with lift ≤ 1 are excluded and counted, by the first reason that
 *     applies; a no-symbol walked endpoint is judged like any other, since its
 *     type-only imports are file edges (bd tea-rags-mcp-r8hme.12);
 *   - a file with two or more silent partners is a root cause;
 *   - `pathPattern` scopes the judged pairs by either endpoint, never the cut;
 *   - no build is reported as not built, not as a clean bill of health.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraphFile,
  TemporalCochangeBuildMeta,
  TemporalCochangeEdgeWithLinkage,
  TemporalCochangeGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  detectSilentCoupling,
  linkImportedCochangePairs,
  oneWalkedViolationImporters,
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
        pair("src/a.ts", "src/b.ts", { lift: 1 }),
      ]),
      files("src/a.ts", "src/b.ts", "src/api.generated.ts"),
      { isDocumentation: (relPath) => relPath.endsWith(".md") },
    );

    expect(report.violations).toEqual([]);
    expect(report.summary.excluded).toEqual({
      testEndpoints: 1,
      generatedEndpoints: 1,
      documentationEndpoints: 1,
      unwalkedEndpoints: 1,
      nonPositiveLift: 1,
      explainedByFacadeChain: 0,
    });
    expect(report.summary.candidateCount).toBe(0);
  });

  it("judges a pair with a no-symbol endpoint: a type-only import links it, no import at all is silent (bd tea-rags-mcp-r8hme.12)", () => {
    // cg_symbols_edges_file_type_only makes an `import type` a file edge, so a
    // barrel / type-only / object-literal module's missing edge IS evidence.
    const report = detectSilentCoupling(
      built([pair("src/a.ts", "src/types.ts"), pair("src/b.ts", "src/types.ts", { structurallyLinked: true })]),
      [...files("src/a.ts", "src/b.ts"), { relPath: "src/types.ts", language: "typescript", symbolCount: 0 }],
    );

    expect(report.violations.map((v) => `${v.relPathA}|${v.relPathB}`)).toEqual(["src/a.ts|src/types.ts"]);
    expect(report.violations[0]?.structuralVisibility).toBe("both-walked");
    expect(report.summary).toMatchObject({ candidateCount: 2, strongCount: 2, strongLinkedCount: 1 });
    expect(report.summary.excluded).not.toHaveProperty("noSymbolEndpoints");
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

/**
 * A pair the codegraph cannot link because one endpoint is not code — a
 * `.tsx` and the `.module.css` it imports (bd tea-rags-mcp-rbnkp). The walker
 * drops an asset import on purpose (bd tea-rags-mcp-unt4v), so the import is
 * read off the importer's declared module specifiers instead.
 */
describe("linkImportedCochangePairs (bd tea-rags-mcp-rbnkp)", () => {
  const CSS_PAIR = pair("pages/TrdEditor.module.css", "pages/TrdEditor.tsx");

  it("links a pair whose importer names the other endpoint with a relative specifier", () => {
    const linked = linkImportedCochangePairs(
      built([CSS_PAIR]),
      new Map([["pages/TrdEditor.tsx", ["react", "./TrdEditor.module.css"]]]),
    );

    expect(linked.edges[0].structurallyLinked).toBe(true);
    expect(detectSilentCoupling(linked, files("pages/TrdEditor.tsx")).violations).toEqual([]);
  });

  it("resolves `..` segments, with either endpoint as the importer", () => {
    const linked = linkImportedCochangePairs(
      built([pair("pages/TrdEditor.module.css", "sections/Intro.tsx")]),
      new Map([["sections/Intro.tsx", ["../pages/TrdEditor.module.css"]]]),
    );

    expect(linked.edges[0].structurallyLinked).toBe(true);
  });

  it("links a baseUrl-style specifier naming the partner's path below some root", () => {
    const linked = linkImportedCochangePairs(
      built([pair("app/javascript/ui-kit/Tour/Tour.module.css", "app/javascript/ui-kit/Tour/Tour.tsx")]),
      new Map([["app/javascript/ui-kit/Tour/Tour.tsx", ["ui-kit/Tour/Tour.module.css"]]]),
    );

    expect(linked.edges[0].structurallyLinked).toBe(true);
  });

  it("keeps a genuine silent pair silent: no specifier resolves to the partner", () => {
    const linked = linkImportedCochangePairs(
      built([
        pair("config/locales/frontend.en.yml", "pages/Client.tsx"),
        pair("other/TrdEditor.module.css", "pages/TrdEditor.tsx"),
        pair("pages/TrdEditor.module.css", "pages/Settings.tsx"),
      ]),
      new Map<string, string[]>([
        ["pages/Client.tsx", ["@/locales/frontend.en.yml", "frontend.en.yml"]],
        ["pages/TrdEditor.tsx", ["./TrdEditor.module.css"]],
        ["pages/Settings.tsx", ["TrdEditor.module.css", "s/TrdEditor.module.css"]],
      ]),
    );

    expect(linked.edges.map((e) => e.structurallyLinked)).toEqual([false, false, false]);
  });

  it("names the walked endpoint of each one-walked violation as the importer to read", () => {
    const walked = files("pages/TrdEditor.tsx", "app/x.ts", "lib/y.ts");
    const report = detectSilentCoupling(built([CSS_PAIR, pair("app/x.ts", "lib/y.ts")]), walked);

    expect(report.violations).toHaveLength(2);
    expect(oneWalkedViolationImporters(report.violations, walked)).toEqual(["pages/TrdEditor.tsx"]);
  });
});

/**
 * bd tea-rags-mcp-r8hme.13: a flagged pair is EXPLAINED by a common neighbour C
 * — both files import C, or one reaches the other through C — when C is
 * SPECIFIC: weight(C) = ln(N / fanIn(C)), N the walked files, fanIn(C) the
 * distinct files importing C. The explained/unexplained cut is Otsu's split
 * over every candidate's best neighbour weight (same helper and population
 * floor as the strength cut); an explained pair leaves the violations and is
 * counted, carrying the neighbour that explained it.
 */
describe("detectSilentCoupling — shared-neighbour explanation (bd tea-rags-mcp-r8hme.13)", () => {
  /**
   * 20 fillers + 19 pair files all import `lib/kernel.ts` (fanIn 39 of N = 42):
   * a hub whose weight ln(42/39) is near zero. `proto/protocol.ts` is imported
   * by the client/server pair only; `c/bridge.ts` joins c/x → d/y; `e/link.ts`
   * joins f/v → e/u (the path in the other direction). Six w/p ↔ w/q pairs
   * share the kernel alone.
   */
  function explanationFixture(): {
    walked: FileDependencyGraphFile[];
    edges: FileDependencyEdge[];
    cochange: TemporalCochangeGraph;
  } {
    const hubPairs = [1, 2, 3, 4, 5, 6].map((i) => [`w/p${i}.ts`, `w/q${i}.ts`] as const);
    const pairFiles = [
      "a/client.ts",
      "b/server.ts",
      "c/x.ts",
      "d/y.ts",
      "e/u.ts",
      "f/v.ts",
      "c/bridge.ts",
      ...hubPairs.flat(),
    ];
    const fillers = Array.from({ length: 20 }, (_, i) => `z/f${i}.ts`);
    const walked = files("lib/kernel.ts", "proto/protocol.ts", "e/link.ts", ...pairFiles, ...fillers);
    const edge = (sourceRelPath: string, targetRelPath: string): FileDependencyEdge => ({
      sourceRelPath,
      targetRelPath,
      callWeight: 1,
    });
    const edges: FileDependencyEdge[] = [
      ...[...pairFiles, ...fillers].map((f) => edge(f, "lib/kernel.ts")),
      edge("a/client.ts", "proto/protocol.ts"),
      edge("b/server.ts", "proto/protocol.ts"),
      edge("c/x.ts", "c/bridge.ts"),
      edge("c/bridge.ts", "d/y.ts"),
      edge("f/v.ts", "e/link.ts"),
      edge("e/link.ts", "e/u.ts"),
    ];
    const cochange = built([
      pair("a/client.ts", "b/server.ts"),
      pair("c/x.ts", "d/y.ts"),
      pair("e/u.ts", "f/v.ts"),
      ...hubPairs.map(([p, q]) => pair(p, q)),
    ]);
    return { walked, edges, cochange };
  }

  const N = 42;
  const HUB_WEIGHT = Math.log(N / 39);

  it("explains a pair by a specific common import, and by a path through a specific file either way", () => {
    const { walked, edges, cochange } = explanationFixture();
    expect(walked).toHaveLength(N);

    const report = detectSilentCoupling(cochange, walked, { fileDependencyEdges: edges });

    const explained = Object.fromEntries(report.explained.map((v) => [`${v.relPathA}|${v.relPathB}`, v.explainedBy]));
    expect(explained).toEqual({
      "a/client.ts|b/server.ts": { relPath: "proto/protocol.ts", weight: expect.closeTo(Math.log(N / 2), 12) },
      "c/x.ts|d/y.ts": { relPath: "c/bridge.ts", weight: expect.closeTo(Math.log(N / 1), 12) },
      "e/u.ts|f/v.ts": { relPath: "e/link.ts", weight: expect.closeTo(Math.log(N / 1), 12) },
    });
    expect(report.violations.map((v) => v.relPathA)).toEqual([
      "w/p1.ts",
      "w/p2.ts",
      "w/p3.ts",
      "w/p4.ts",
      "w/p5.ts",
      "w/p6.ts",
    ]);
  });

  it("keeps a pair flagged when its only shared neighbour is a hub most files import", () => {
    const { walked, edges, cochange } = explanationFixture();

    const report = detectSilentCoupling(cochange, walked, { fileDependencyEdges: edges });

    for (const v of report.violations) expect(v.explainedBy).toBeUndefined();
    expect(report.summary.violationCount).toBe(6);
    expect(report.summary.explainedCount).toBe(3);
  });

  it("draws the explained/unexplained cut with Otsu over every candidate's best neighbour weight", () => {
    const { walked, edges, cochange } = explanationFixture();

    const { summary } = detectSilentCoupling(cochange, walked, { fileDependencyEdges: edges });

    expect(summary.sharedNeighbourThresholdMethod).toBe("otsu");
    // Six hub weights below, ln(42/2) the smallest specific weight above.
    expect(summary.sharedNeighbourThreshold).toBeCloseTo((HUB_WEIGHT + Math.log(N / 2)) / 2, 12);
    expect(summary.sharedNeighbourSeparability).toBeGreaterThan(0.9);
    expect(summary.sharedNeighbourSeparability).toBeLessThanOrEqual(1);
  });

  it("explains nothing when too few candidates share a neighbour for Otsu to be trusted", () => {
    const { walked, edges } = explanationFixture();
    const cochange = built([pair("a/client.ts", "b/server.ts"), pair("w/p1.ts", "w/q1.ts")]);

    const report = detectSilentCoupling(cochange, walked, { fileDependencyEdges: edges });

    expect(report.summary.sharedNeighbourThresholdMethod).toBe("none");
    expect(report.summary.sharedNeighbourThreshold).toBeUndefined();
    expect(report.summary.explainedCount).toBe(0);
    expect(report.explained).toEqual([]);
    expect(report.violations).toHaveLength(2);
  });

  it("explains nothing when the dependency edges are not supplied", () => {
    const { walked, cochange } = explanationFixture();

    const report = detectSilentCoupling(cochange, walked);

    expect(report.summary.sharedNeighbourThresholdMethod).toBe("none");
    expect(report.summary.explainedCount).toBe(0);
    expect(report.violations).toHaveLength(9);
  });

  it("drops explained pairs from root causes, which count silent partners only", () => {
    const { walked, edges, cochange } = explanationFixture();
    const withSecondPartner = built([...cochange.edges, pair("a/client.ts", "z/f0.ts")]);

    const report = detectSilentCoupling(withSecondPartner, walked, { fileDependencyEdges: edges });

    // a/client.ts has two strong partners, but server is explained: one silent partner is no root cause.
    expect(report.explained.map((v) => v.relPathB)).toContain("b/server.ts");
    expect(report.rootCauses.map((r) => r.relPath)).not.toContain("a/client.ts");
  });
});

describe("detectSilentCoupling — facade-chain explanation (bd tea-rags-mcp-89k7k.27)", () => {
  /**
   * The bd tea-rags-mcp-89k7k.27 repro shape: a producer imports a module's
   * vocabulary through two adopted barrels (`app/index.ts` →
   * `app/boundary/index.ts`) and never the vocabulary file itself, yet all
   * four files change together. The barrel chain, not the pair, is the
   * coupling the code declares.
   */
  function facadeChainFixture(): {
    walked: FileDependencyGraphFile[];
    edges: FileDependencyEdge[];
    cochange: TemporalCochangeGraph;
  } {
    const walked = files("ops/consumer.ts", "app/index.ts", "app/boundary/index.ts", "app/boundary/types.ts");
    const edge = (sourceRelPath: string, targetRelPath: string): FileDependencyEdge => ({
      sourceRelPath,
      targetRelPath,
      callWeight: 1,
    });
    const edges: FileDependencyEdge[] = [
      edge("ops/consumer.ts", "app/index.ts"),
      edge("app/index.ts", "app/boundary/index.ts"),
      edge("app/boundary/index.ts", "app/boundary/types.ts"),
    ];
    return { walked, edges, cochange: built([pair("ops/consumer.ts", "app/boundary/types.ts")]) };
  }

  it("counts a barrel-mediated pair under explainedByFacadeChain instead of judging it", () => {
    const { walked, edges, cochange } = facadeChainFixture();

    const report = detectSilentCoupling(cochange, walked, { fileDependencyEdges: edges });

    expect(report.violations).toEqual([]);
    expect(report.explained).toEqual([]);
    expect(report.summary.explainedCount).toBe(0);
    expect(report.summary.excluded).toEqual({
      testEndpoints: 0,
      generatedEndpoints: 0,
      documentationEndpoints: 0,
      unwalkedEndpoints: 0,
      nonPositiveLift: 0,
      explainedByFacadeChain: 1,
    });
  });

  it("explains the chain whichever endpoint is the consumer", () => {
    const { walked, edges } = facadeChainFixture();

    const report = detectSilentCoupling(built([pair("app/boundary/types.ts", "ops/consumer.ts")]), walked, {
      fileDependencyEdges: edges,
    });

    expect(report.violations).toEqual([]);
    expect(report.summary.excluded.explainedByFacadeChain).toBe(1);
  });

  it("still judges a DIRECT deep import of the vocabulary: no entry file between, nothing explains it", () => {
    const { walked, cochange } = facadeChainFixture();
    // The deep import sits in plain sight on the walked graph — the shape the
    // leakingAbstraction detector flags as a bypass, and the pair the
    // detector exists for. A direct edge is no chain.
    const edges: FileDependencyEdge[] = [
      { sourceRelPath: "ops/consumer.ts", targetRelPath: "app/boundary/types.ts", callWeight: 1 },
    ];

    const report = detectSilentCoupling(cochange, walked, { fileDependencyEdges: edges });

    expect(report.violations.map((v) => `${v.relPathA} ~ ${v.relPathB}`)).toEqual([
      "ops/consumer.ts ~ app/boundary/types.ts",
    ]);
    expect(report.summary.excluded.explainedByFacadeChain).toBe(0);
  });

  it("still judges a pair whose chain leaves the barrels: an ordinary module in the middle is not a facade", () => {
    const { walked, cochange } = facadeChainFixture();
    const edges: FileDependencyEdge[] = [
      { sourceRelPath: "ops/consumer.ts", targetRelPath: "app/index.ts", callWeight: 1 },
      { sourceRelPath: "app/index.ts", targetRelPath: "app/boundary/bridge.ts", callWeight: 1 },
      { sourceRelPath: "app/boundary/bridge.ts", targetRelPath: "app/boundary/types.ts", callWeight: 1 },
    ];

    const report = detectSilentCoupling(cochange, [...walked, ...files("app/boundary/bridge.ts")], {
      fileDependencyEdges: edges,
    });

    expect(report.violations).toHaveLength(1);
    expect(report.summary.excluded.explainedByFacadeChain).toBe(0);
  });

  it("explains nothing when the dependency edges are not supplied", () => {
    const { walked, cochange } = facadeChainFixture();

    const report = detectSilentCoupling(cochange, walked);

    expect(report.violations).toHaveLength(1);
    expect(report.summary.excluded.explainedByFacadeChain).toBe(0);
  });
});
