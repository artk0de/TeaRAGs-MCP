/**
 * Inferred layering (bd tea-rags-mcp-r8hme.22): the component graph condensed
 * by SCC, levels by longest path (L0 = foundation), height AND depth per
 * component, a greedy weighted feedback arc set per knot, layering coverage
 * and the rank correlation of level vs instability. Violations: knots, the
 * minority-weight back-edges inside them, abstraction bypasses (DIP);
 * informational: composition cycles, detached islands, layer skips.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
  TypeAbstractnessCensus,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildComponentGraph,
  buildLayeringModel,
  detectLayeringViolations,
  lookupLayeringKnot,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function file(relPath: string, typeAbstractness?: TypeAbstractnessCensus) {
  return { relPath, language: "typescript", symbolCount: 1, ...(typeAbstractness ? { typeAbstractness } : {}) };
}

function edge(sourceRelPath: string, targetRelPath: string, callWeight = 1): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight };
}

const census = (abstractTypeCount: number, concreteTypeCount: number) => ({ abstractTypeCount, concreteTypeCount });

/**
 * `core` ← `lib` ← `svc` ← `app`, plus two side entries: `app/deep.ts` reaching
 * core directly (a layer skip, L3 → L0) and `proto` depending on core with
 * nothing depending on it (a detached island). No census — no bypass is
 * judged without one.
 */
function layered(): FileDependencyGraph {
  const files = [
    file("core/a.ts"),
    file("core/b.ts"),
    file("lib/x.ts"),
    file("lib/y.ts"),
    file("svc/s.ts"),
    file("svc/t.ts"),
    file("app/m.ts"),
    file("app/n.ts"),
    file("app/deep.ts"),
    file("proto/p.ts"),
  ];
  const edges = [
    edge("lib/x.ts", "core/a.ts"),
    edge("lib/y.ts", "core/b.ts"),
    edge("svc/s.ts", "lib/x.ts"),
    edge("svc/t.ts", "lib/y.ts"),
    edge("app/m.ts", "svc/s.ts"),
    edge("app/n.ts", "svc/t.ts"),
    edge("app/deep.ts", "core/a.ts"),
    edge("proto/p.ts", "core/a.ts"),
  ];
  return { files, edges };
}

/**
 * `device` ← `ulanzi` ← `clock`, with `ulanzi → clock` closing a 2-component
 * knot held by the weight-1 minority edge (clock → ulanzi carries 4).
 * `app` reaches `ulanzi` — a measured-concrete component — while it depends on
 * the measured-abstract `device` below it, and never touches `device` itself.
 */
function knot(): FileDependencyGraph {
  const files = [
    file("device/d.ts", census(6, 0)),
    file("ulanzi/u1.ts", census(0, 3)),
    file("ulanzi/u2.ts", census(0, 3)),
    file("clock/c1.ts", census(0, 3)),
    file("clock/c2.ts", census(0, 3)),
    file("app/s.ts", census(0, 6)),
  ];
  const edges = [
    edge("ulanzi/u1.ts", "device/d.ts"),
    edge("ulanzi/u2.ts", "device/d.ts"),
    edge("clock/c1.ts", "ulanzi/u1.ts", 3),
    edge("clock/c2.ts", "ulanzi/u2.ts", 1),
    edge("ulanzi/u1.ts", "clock/c1.ts", 1),
    edge("app/s.ts", "ulanzi/u1.ts"),
  ];
  return { files, edges };
}

/** `x ⇄ y` at equal weight over a shared `base` — a knot with no guessable direction. */
function symmetric(): FileDependencyGraph {
  return {
    files: [file("base/b.ts"), file("x/x.ts"), file("y/y.ts")],
    edges: [
      edge("x/x.ts", "base/b.ts", 2),
      edge("y/y.ts", "base/b.ts", 2),
      edge("x/x.ts", "y/y.ts", 2),
      edge("y/y.ts", "x/x.ts", 2),
    ],
  };
}

/** `parent ⇄ parent/nested` — every edge joins a directory to one nested inside it. */
function composition(): FileDependencyGraph {
  return {
    files: [file("parent/own.ts"), file("parent/nested/inner.ts")],
    edges: [edge("parent/own.ts", "parent/nested/inner.ts"), edge("parent/nested/inner.ts", "parent/own.ts")],
  };
}

/**
 * Two same-size knots whose names sort the opposite way from their harm (bd
 * tea-rags-mcp-r8hme.32). `a1 ⇄ a2` is a tangle: both members volatile
 * (I = 2/3, spread 0). `ms ⇄ mv` fuses a stable member with a volatile one:
 * three `use*` directories depend on `ms` (I = 1/5) while `mv` leans on it and
 * on the foundation (I = 2/3) — an SDP break inside a cycle, spread 7/15.
 */
function spreadKnots(): FileDependencyGraph {
  const files = [
    file("zz/f.ts"),
    file("ms/index.ts"),
    file("mv/core.ts"),
    file("use1/u.ts"),
    file("use2/u.ts"),
    file("use3/u.ts"),
    file("a1/a.ts"),
    file("a2/a.ts"),
  ];
  const edges = [
    edge("use1/u.ts", "ms/index.ts"),
    edge("use2/u.ts", "ms/index.ts"),
    edge("use3/u.ts", "ms/index.ts"),
    edge("ms/index.ts", "mv/core.ts"),
    edge("mv/core.ts", "ms/index.ts"),
    edge("mv/core.ts", "zz/f.ts"),
    edge("a1/a.ts", "a2/a.ts"),
    edge("a2/a.ts", "a1/a.ts"),
    edge("a1/a.ts", "zz/f.ts"),
    edge("a2/a.ts", "zz/f.ts"),
  ];
  return { files, edges };
}

function judge(g: FileDependencyGraph) {
  return detectLayeringViolations(buildComponentGraph(g, []), g.files);
}

describe("buildLayeringModel", () => {
  it("levels the condensed graph from the sinks and reports height and depth per component", () => {
    const model = buildLayeringModel(buildComponentGraph(layered(), []));

    expect(model.levelCount).toBe(4);
    expect(model.positions.get("core")).toEqual({ level: 0, depth: 3, inKnot: false });
    expect(model.positions.get("lib")).toEqual({ level: 1, depth: 2, inKnot: false });
    expect(model.positions.get("svc")).toEqual({ level: 2, depth: 1, inKnot: false });
    expect(model.positions.get("app")).toEqual({ level: 3, depth: 0, inKnot: false });
    expect(model.positions.get("proto")).toEqual({ level: 1, depth: 0, inKnot: false });
    expect(model.knots).toEqual([]);
    expect(model.coverage).toBe(1);
  });

  it("condenses a knot to one node, and the weighted FAS cuts one edge", () => {
    const model = buildLayeringModel(buildComponentGraph(knot(), []));

    expect(model.levelCount).toBe(3);
    expect(model.positions.get("device")).toEqual({ level: 0, depth: 2, inKnot: false });
    expect(model.positions.get("clock")).toEqual({ level: 1, depth: 1, inKnot: true });
    expect(model.positions.get("ulanzi")).toEqual({ level: 1, depth: 1, inKnot: true });
    expect(model.positions.get("app")).toEqual({ level: 2, depth: 0, inKnot: false });
    expect(model.knots).toEqual([
      {
        components: ["ulanzi", "clock"],
        // Canonical ELS (bd tea-rags-mcp-r8hme.42): the weighted delta takes
        // clock (+3) into the right block first, ulanzi follows as the sink,
        // and the sequence [ulanzi, clock] reads clock → ulanzi backwards —
        // the whole 4-weight flow, not the minority edge.
        feedbackArcSet: [
          {
            sourceComponent: "clock",
            targetComponent: "ulanzi",
            callWeight: 4,
            fileEdges: [
              { sourceRelPath: "clock/c1.ts", targetRelPath: "ulanzi/u1.ts", callWeight: 3 },
              { sourceRelPath: "clock/c2.ts", targetRelPath: "ulanzi/u2.ts", callWeight: 1 },
            ],
          },
        ],
        cutEdgeCount: 1,
        levelsAfterCut: 2,
        composition: false,
        // ulanzi reads 2/5, clock 2/3 — the cycle leans on the stable side.
        // Same arithmetic as the implementation, so the doubles agree.
        instabilitySpread: 2 / 3 - 2 / 5,
      },
    ]);
    expect(model.coverage).toBe(0.5);
    // Pearson over average ranks: the ulanzi/clock tie in level costs a little.
    expect(model.coherence).toBeCloseTo(Math.sqrt(0.9), 6);
  });

  it("reports each knot member's own instability as the spread (bd tea-rags-mcp-r8hme.32)", () => {
    const model = buildLayeringModel(buildComponentGraph(spreadKnots(), []));

    // Per-member, never a condensed value: `mv` reads 1/2 (one file reaching
    // two targets counts Ce once) while `ms` reads 1/5 inside the same knot.
    expect(model.knots.map((k) => [k.components, k.instabilitySpread])).toEqual([
      [["a1", "a2"], 0],
      [["ms", "mv"], 1 / 2 - 1 / 5],
    ]);
    // Coherence keeps per-component instability inside knots too: the number
    // is the hand-computed Pearson over the average ranks of level (0; 1×4;
    // 2×3 → ranks 1; 3.5; 7) and instability (0; 1/5; 1/2; 1/2; 1/2; 1×3 →
    // ranks 1; 2; 4; 4; 4; 7) for zz, ms, mv, a1, a2 and the three use*
    // directories.
    expect(model.coherence).toBeCloseTo(35 / Math.sqrt(35 * 38), 9);
  });
});

describe("detectLayeringViolations", () => {
  it("ranks knot findings by member-instability spread, not by name (bd tea-rags-mcp-r8hme.32)", () => {
    const report = judge(spreadKnots());

    // `ms ⇄ mv` carries an SDP break inside the cycle (0.2 vs 2/3); the
    // uniform `a1 ⇄ a2` tangle ranks below it despite sorting first by name.
    expect(report.violations.filter((v) => v.kind === "knot").map((v) => [v.components, v.instabilitySpread])).toEqual([
      [["ms", "mv"], 1 / 2 - 1 / 5],
      [["a1", "a2"], 0],
    ]);
  });

  it("reports a clean stack with its coherence, and no violation", () => {
    // core ← lib ← svc ← app, every instability distinct, so the monotone
    // stack reads coherence 1 — the inferred layers are real.
    const clean = {
      files: [
        file("core/a.ts"),
        file("core/b.ts"),
        file("lib/x.ts"),
        file("lib/y.ts"),
        file("svc/s1.ts"),
        file("svc/s2.ts"),
        file("svc/s3.ts"),
        file("svc/s4.ts"),
        file("app/m.ts"),
        file("app/n.ts"),
      ],
      edges: [
        edge("lib/x.ts", "core/a.ts"),
        edge("lib/y.ts", "core/b.ts"),
        edge("svc/s1.ts", "lib/x.ts"),
        edge("svc/s2.ts", "lib/x.ts"),
        edge("svc/s3.ts", "lib/y.ts"),
        edge("svc/s4.ts", "lib/y.ts"),
        edge("app/m.ts", "svc/s1.ts"),
        edge("app/n.ts", "svc/s2.ts"),
      ],
    };
    expect(judge(clean)).toEqual({
      violations: [],
      summary: {
        componentCount: 4,
        componentEdgeCount: 3,
        levelCount: 4,
        coverage: 1,
        coherence: 1,
        knotCount: 0,
        backEdgeCount: 0,
        abstractionBypassCount: 0,
        compositionCycleCount: 0,
        islandCount: 0,
        layerSkipCount: 0,
        violationCount: 0,
      },
    });
  });

  it("reports a knot ranked by Ca with the feedback arc set that dissolves it, and the minority back-edge", () => {
    const report = judge(knot());

    expect(report.violations).toEqual([
      {
        kind: "knot",
        components: ["ulanzi", "clock"],
        feedbackArcSet: [
          {
            sourceComponent: "clock",
            targetComponent: "ulanzi",
            callWeight: 4,
            fileEdges: [
              { sourceRelPath: "clock/c1.ts", targetRelPath: "ulanzi/u1.ts", callWeight: 3 },
              { sourceRelPath: "clock/c2.ts", targetRelPath: "ulanzi/u2.ts", callWeight: 1 },
            ],
          },
        ],
        cutEdgeCount: 1,
        levelsAfterCut: 2,
        drillDown: { knotOf: "ulanzi" },
        instabilitySpread: 2 / 3 - 2 / 5,
      },
      {
        kind: "backEdge",
        sourceComponent: "ulanzi",
        targetComponent: "clock",
        callWeight: 1,
        counterFlowWeight: 4,
        fileEdgeCount: 1,
        fileEdges: [{ sourceRelPath: "ulanzi/u1.ts", targetRelPath: "clock/c1.ts", callWeight: 1 }],
      },
      {
        kind: "abstractionBypass",
        sourceComponent: "app",
        targetComponent: "ulanzi",
        bypassedComponent: "device",
        concreteAbstractness: 0,
        bypassedAbstractness: 1,
        callWeight: 1,
      },
    ]);
    expect(report.summary).toMatchObject({
      componentCount: 4,
      componentEdgeCount: 4,
      levelCount: 3,
      coverage: 0.5,
      coherence: Math.sqrt(0.9),
      knotCount: 1,
      backEdgeCount: 1,
      abstractionBypassCount: 1,
      violationCount: 3,
    });
  });

  it("never guesses a back-edge when both directions carry the same weight, but still reports the knot", () => {
    const report = judge(symmetric());

    expect(report.violations).toEqual([
      {
        kind: "knot",
        components: ["x", "y"],
        feedbackArcSet: [
          {
            sourceComponent: "x",
            targetComponent: "y",
            callWeight: 2,
            fileEdges: [{ sourceRelPath: "x/x.ts", targetRelPath: "y/y.ts", callWeight: 2 }],
          },
        ],
        cutEdgeCount: 1,
        levelsAfterCut: 2,
        drillDown: { knotOf: "x" },
        // x and y read the same instability (1/2 each) — a tangle, not a break.
        instabilitySpread: 0,
      },
    ]);
    expect(report.summary).toMatchObject({
      componentCount: 3,
      componentEdgeCount: 4,
      levelCount: 2,
      coverage: 1 / 3,
      coherence: 1,
      knotCount: 1,
      backEdgeCount: 0,
      violationCount: 1,
    });
  });

  it("reports a parent↔nested cycle as composition, never as a knot", () => {
    const report = judge(composition());

    expect(report.violations).toEqual([
      {
        kind: "compositionCycle",
        components: ["parent", "parent/nested"],
        nestedPairs: [{ parentComponent: "parent", nestedComponent: "parent/nested" }],
      },
    ]);
    expect(report.summary).toMatchObject({
      componentCount: 2,
      componentEdgeCount: 2,
      levelCount: 1,
      coverage: 0,
      knotCount: 0,
      compositionCycleCount: 1,
      violationCount: 1,
    });
  });

  it("reports detached islands and layer skips as informational findings", () => {
    const report = judge(layered());

    expect(report.violations).toEqual([
      {
        kind: "island",
        component: "proto",
        height: 1,
        depth: 0,
        afferentCount: 0,
        instability: 1,
      },
      {
        kind: "layerSkip",
        sourceComponent: "app",
        targetComponent: "core",
        sourceLevel: 3,
        targetLevel: 0,
        skippedLevels: 3,
        callWeight: 1,
      },
    ]);
    expect(report.summary).toMatchObject({
      componentCount: 5,
      componentEdgeCount: 5,
      levelCount: 4,
      coverage: 1,
      // Pearson over average ranks, computed by hand for this fixture.
      coherence: 6 / Math.sqrt(9.5 * 9),
      knotCount: 0,
      islandCount: 1,
      layerSkipCount: 1,
      violationCount: 2,
    });
  });

  it("does not report a composition root or a fully-isolated graph as islands", () => {
    // The app sits at the top level with nothing above it — that is a root, not an island.
    const rooted = layered();
    rooted.files = rooted.files.filter((f) => !f.relPath.startsWith("proto/"));
    rooted.edges = rooted.edges.filter((e) => e.sourceRelPath !== "proto/p.ts");
    const rootedReport = judge(rooted);
    expect(rootedReport.violations.map((v) => v.kind)).toEqual(["layerSkip"]);
    expect(rootedReport.summary.islandCount).toBe(0);

    // One component, no edges: no level to hang below, nothing is detached.
    const alone = { files: [file("solo/s.ts")], edges: [] };
    expect(judge(alone)).toEqual({
      violations: [],
      summary: {
        componentCount: 1,
        componentEdgeCount: 0,
        levelCount: 0,
        coverage: 1,
        coherence: 0,
        knotCount: 0,
        backEdgeCount: 0,
        abstractionBypassCount: 0,
        compositionCycleCount: 0,
        islandCount: 0,
        layerSkipCount: 0,
        violationCount: 0,
      },
    });
  });

  it("judges no bypass without a measured type census on both ends", () => {
    const unmeasured = knot();
    unmeasured.files = unmeasured.files.map(({ relPath, language, symbolCount }) => ({
      relPath,
      language,
      symbolCount,
    }));

    const report = judge(unmeasured);

    expect(report.violations.map((v) => v.kind)).toEqual(["knot", "backEdge"]);
    expect(report.summary.abstractionBypassCount).toBe(0);
  });

  it("reads an empty graph as an empty report", () => {
    const empty = { files: [], edges: [] };
    expect(judge(empty)).toEqual({
      violations: [],
      summary: {
        componentCount: 0,
        componentEdgeCount: 0,
        levelCount: 0,
        coverage: 0,
        coherence: 0,
        knotCount: 0,
        backEdgeCount: 0,
        abstractionBypassCount: 0,
        compositionCycleCount: 0,
        islandCount: 0,
        layerSkipCount: 0,
        violationCount: 0,
      },
    });
  });
});

describe("detectLayeringViolations — source scope (bd tea-rags-mcp-r8hme.33)", () => {
  function judgeScoped(g: FileDependencyGraph, sourcePathPattern: string) {
    return detectLayeringViolations(buildComponentGraph(g, []), g.files, { sourcePathPattern });
  }

  it("keeps the findings carried by a matching source file, and levels the whole graph", () => {
    const report = judgeScoped(knot(), "app/**");

    // The knot and its back-edge live in ulanzi/clock — out of scope. The
    // bypass starts in app — in scope.
    expect(report.violations.map((v) => v.kind)).toEqual(["abstractionBypass"]);
    expect(report.summary).toMatchObject({
      componentCount: 4,
      levelCount: 3,
      coverage: 0.5,
      knotCount: 0,
      backEdgeCount: 0,
      abstractionBypassCount: 1,
      violationCount: 1,
      scope: { sourcePathPattern: "app/**", outOfScopeFindingCount: 2 },
    });
  });

  it("keeps a knot when any member owns a matching file, and a back-edge by the file carrying it", () => {
    const report = judgeScoped(knot(), "ulanzi/**");

    expect(report.violations.map((v) => v.kind)).toEqual(["knot", "backEdge"]);
    expect(report.summary.scope).toEqual({ sourcePathPattern: "ulanzi/**", outOfScopeFindingCount: 1 });
  });

  it("drops a back-edge whose carrying file is outside the pattern even when its knot stays", () => {
    const report = judgeScoped(knot(), "clock/**");

    // clock is a knot member, but the minority edge ulanzi → clock is carried by ulanzi/u1.ts.
    expect(report.violations.map((v) => v.kind)).toEqual(["knot"]);
    expect(report.summary).toMatchObject({ knotCount: 1, backEdgeCount: 0, abstractionBypassCount: 0 });
  });

  it("scopes islands by their own files and layer skips by the file carrying the dependency", () => {
    expect(judgeScoped(layered(), "proto/**").violations.map((v) => v.kind)).toEqual(["island"]);
    expect(judgeScoped(layered(), "app/deep.ts").violations.map((v) => v.kind)).toEqual(["layerSkip"]);
    expect(judgeScoped(layered(), "app/m.ts").violations).toEqual([]);
  });

  it("honours a negated pattern", () => {
    const report = judgeScoped(layered(), "!proto/**");

    expect(report.violations.map((v) => v.kind)).toEqual(["layerSkip"]);
    expect(report.summary.scope).toEqual({ sourcePathPattern: "!proto/**", outOfScopeFindingCount: 1 });
  });

  it("reports no scope when no pattern is given", () => {
    const g = knot();
    expect(judge(g).summary.scope).toBeUndefined();
    expect(detectLayeringViolations(buildComponentGraph(g, []), g.files, {}).summary.scope).toBeUndefined();
  });

  it("projects a kept knot onto its in-scope members and the cut edges an in-scope file carries", () => {
    const whole = judge(knot()).violations.find((v) => v.kind === "knot");
    const scoped = judgeScoped(knot(), "clock/**").violations.find((v) => v.kind === "knot");

    // ulanzi owns no clock/** file; the cut edge clock → ulanzi is carried by
    // the clock files, so the projected knot keeps it.
    expect(scoped).toMatchObject({
      kind: "knot",
      components: ["clock"],
      outOfScopeMemberCount: 1,
      feedbackArcSet: [
        {
          sourceComponent: "clock",
          targetComponent: "ulanzi",
          callWeight: 4,
          fileEdges: [
            { sourceRelPath: "clock/c1.ts", targetRelPath: "ulanzi/u1.ts", callWeight: 3 },
            { sourceRelPath: "clock/c2.ts", targetRelPath: "ulanzi/u2.ts", callWeight: 1 },
          ],
        },
      ],
      outOfScopeFeedbackEdgeCount: 0,
    });
    // The cost of dissolving the WHOLE knot does not shrink with the scope.
    expect(whole).toBeDefined();
    expect(scoped).toMatchObject({
      cutEdgeCount: whole?.kind === "knot" ? whole.cutEdgeCount : -1,
      levelsAfterCut: whole?.kind === "knot" ? whole.levelsAfterCut : -1,
    });
  });

  it("keeps no cut edge in a projected knot when an out-of-scope file carries it", () => {
    const scoped = judgeScoped(knot(), "ulanzi/**").violations.find((v) => v.kind === "knot");

    // The cut edge clock → ulanzi is carried by the clock files; ulanzi owns none.
    expect(scoped).toMatchObject({
      components: ["ulanzi"],
      outOfScopeMemberCount: 1,
      feedbackArcSet: [],
      outOfScopeFeedbackEdgeCount: 1,
    });
  });

  it("carries no projection counts on an unscoped knot", () => {
    const whole = judge(knot()).violations.find((v) => v.kind === "knot");

    expect(whole).not.toHaveProperty("outOfScopeMemberCount");
    expect(whole).not.toHaveProperty("outOfScopeFeedbackEdgeCount");
  });

  it("projects a composition cycle onto its in-scope members, keeping the pairs they belong to", () => {
    const scoped = judgeScoped(composition(), "parent/nested/**").violations.find((v) => v.kind === "compositionCycle");

    expect(scoped).toEqual({
      kind: "compositionCycle",
      components: ["parent/nested"],
      nestedPairs: [{ parentComponent: "parent", nestedComponent: "parent/nested" }],
      outOfScopeMemberCount: 1,
    });
  });
});

/**
 * `x/a ⇄ x/b` under one subtree, with `ext` also depending on `x/b` — the
 * knot's top member by Ca is `x/b`, and every member sits under `x/`.
 */
function subtreeKnot(): FileDependencyGraph {
  return {
    files: [file("x/a/a.ts"), file("x/b/b.ts"), file("ext/e.ts")],
    edges: [edge("x/a/a.ts", "x/b/b.ts", 3), edge("x/b/b.ts", "x/a/a.ts"), edge("ext/e.ts", "x/b/b.ts")],
  };
}

describe("detectLayeringViolations — knot drillDown (bd tea-rags-mcp-r8hme.38)", () => {
  const knotFinding = (violations: ReturnType<typeof judge>["violations"]) => {
    const found = violations.find((v) => v.kind === "knot");
    if (found?.kind !== "knot") throw new Error("no knot finding");
    return found;
  };

  it("names the top member by Ca and the deepest common ancestor of every member", () => {
    expect(knotFinding(judge(subtreeKnot()).violations).drillDown).toEqual({ knotOf: "x/b", pathPattern: "x/**" });
  });

  it("omits the pathPattern when the members share no directory below the repository root", () => {
    expect(knotFinding(judge(knot()).violations).drillDown).toEqual({ knotOf: "ulanzi" });
  });

  it("keeps the whole-knot drillDown on a finding projected onto a scope", () => {
    const g = knot();
    const scoped = detectLayeringViolations(buildComponentGraph(g, []), g.files, { sourcePathPattern: "clock/**" });

    // ulanzi is out of scope, yet it stays the handle of the whole knot.
    expect(knotFinding(scoped.violations)).toMatchObject({ components: ["clock"], drillDown: { knotOf: "ulanzi" } });
  });

  it("carries no drillDown on a composition cycle", () => {
    const cycle = judge(composition()).violations.find((v) => v.kind === "compositionCycle");

    expect(cycle).toBeDefined();
    expect(cycle).not.toHaveProperty("drillDown");
  });

  it("judges a prebuilt model exactly as it judges the graph it was built from", () => {
    const g = knot();
    const componentGraph = buildComponentGraph(g, []);

    expect(detectLayeringViolations(componentGraph, g.files, { model: buildLayeringModel(componentGraph) })).toEqual(
      detectLayeringViolations(componentGraph, g.files),
    );
  });
});

describe("lookupLayeringKnot (bd tea-rags-mcp-r8hme.38)", () => {
  const lookup = (g: FileDependencyGraph, component: string, sourcePathPattern?: string) => {
    const componentGraph = buildComponentGraph(g, []);
    return lookupLayeringKnot(componentGraph, buildLayeringModel(componentGraph), component, { sourcePathPattern });
  };

  it("returns the whole knot of a member: every member, the full cut, and its back-edges", () => {
    expect(lookup(knot(), "clock")).toEqual({
      kind: "inKnot",
      component: "clock",
      position: { level: 1, depth: 1, inKnot: true },
      knot: {
        components: ["ulanzi", "clock"],
        feedbackArcSet: [
          {
            sourceComponent: "clock",
            targetComponent: "ulanzi",
            callWeight: 4,
            fileEdges: [
              { sourceRelPath: "clock/c1.ts", targetRelPath: "ulanzi/u1.ts", callWeight: 3 },
              { sourceRelPath: "clock/c2.ts", targetRelPath: "ulanzi/u2.ts", callWeight: 1 },
            ],
          },
        ],
        cutEdgeCount: 1,
        levelsAfterCut: 2,
        composition: false,
        backEdges: [
          {
            kind: "backEdge",
            sourceComponent: "ulanzi",
            targetComponent: "clock",
            callWeight: 1,
            counterFlowWeight: 4,
            fileEdgeCount: 1,
            fileEdges: [{ sourceRelPath: "ulanzi/u1.ts", targetRelPath: "clock/c1.ts", callWeight: 1 }],
          },
        ],
      },
    });
  });

  it("returns the position of a known component outside every knot", () => {
    expect(lookup(knot(), "device")).toEqual({
      kind: "notInKnot",
      component: "device",
      position: { level: 0, depth: 2, inKnot: false },
    });
  });

  it("returns a composition cycle's member with the composition flag and no back-edge", () => {
    expect(lookup(composition(), "parent/nested")).toMatchObject({
      kind: "inKnot",
      knot: { components: expect.arrayContaining(["parent", "parent/nested"]), composition: true, backEdges: [] },
    });
  });

  it("says a component the graph does not hold is unknown", () => {
    expect(lookup(knot(), "nowhere")).toEqual({ kind: "unknownComponent", component: "nowhere" });
  });

  it("projects the knot onto a scope the way the knot finding is projected", () => {
    // The cut edge clock → ulanzi is carried by the clock files — in scope;
    // the back-edge is carried by ulanzi/u1.ts — out of scope.
    expect(lookup(knot(), "ulanzi", "clock/**")).toMatchObject({
      kind: "inKnot",
      position: { level: 1, depth: 1, inKnot: true },
      knot: {
        components: ["clock"],
        feedbackArcSet: [
          {
            sourceComponent: "clock",
            targetComponent: "ulanzi",
            callWeight: 4,
            fileEdges: [
              { sourceRelPath: "clock/c1.ts", targetRelPath: "ulanzi/u1.ts", callWeight: 3 },
              { sourceRelPath: "clock/c2.ts", targetRelPath: "ulanzi/u2.ts", callWeight: 1 },
            ],
          },
        ],
        cutEdgeCount: 1,
        backEdges: [],
        outOfScopeMemberCount: 1,
        outOfScopeFeedbackEdgeCount: 0,
      },
    });
  });

  it("carries no projection counts when unscoped", () => {
    const found = lookup(knot(), "clock");

    expect(found.kind === "inKnot" ? found.knot : {}).not.toHaveProperty("outOfScopeMemberCount");
  });
});
