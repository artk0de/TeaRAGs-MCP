/**
 * ArchitectureReportOps (bd tea-rags-mcp-94hd9) — the query behind
 * `get_architecture_report`: reads the file dependency graph from a codegraph
 * handle, runs the Stable Dependencies detector, and shapes the typed report.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ArchitectureReportOps,
  buildArchitectureKnotMembership,
} from "../../../../../src/core/api/internal/ops/architecture-report-ops.js";
import { UnknownArchitectureComponentError } from "../../../../../src/core/api/public/errors.js";
import type {
  FileDependencyGraph,
  NonPublicMemberEdge,
  TemporalCochangeEdgeWithLinkage,
  TemporalCochangeGraph,
} from "../../../../../src/core/contracts/types/codegraph.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

/**
 * INVARIANT CHANGED (bd tea-rags-mcp-r8hme.7): Stable Dependencies is judged
 * on COMPONENTS, not files — the file-level fixture this block used produced
 * no component with enough support. Components here are plain directories.
 *
 * `core/` (a, b): imported by 6 `app/` files and by `lib/f5.ts`, both files
 * import `lib/` → Ca 7, Ce 2, I = 2/9. `base/a.ts`: imported by 6 `users/`
 * files, imports `lib/f4.ts` → Ca 6, Ce 1, I = 1/7. `lib/` (f1..f5, each
 * importing `vendor/v.ts`): imported by core a/b, base/a and `other/o.ts` →
 * Ca 4, Ce 5, I = 5/9. core → lib and base → lib both run uphill; lib → core
 * closes a cycle with a dependent.
 */
function graph(): FileDependencyGraph {
  const files = [file("core/a.ts"), file("core/b.ts"), file("base/a.ts"), file("other/o.ts"), file("vendor/v.ts")];
  const edges: FileDependencyGraph["edges"] = [];
  const add = (sourceRelPath: string, targetRelPath: string, callWeight = 1) => {
    edges.push({ sourceRelPath, targetRelPath, callWeight });
  };
  add("core/a.ts", "lib/f1.ts", 2);
  add("core/b.ts", "lib/f2.ts");
  add("base/a.ts", "lib/f4.ts", 3);
  add("other/o.ts", "lib/f3.ts");
  for (let i = 1; i <= 6; i++) {
    files.push(file(`app/c${i}.ts`), file(`users/u${i}.ts`));
    add(`app/c${i}.ts`, "core/b.ts");
    add(`users/u${i}.ts`, "base/a.ts");
  }
  for (let i = 1; i <= 5; i++) {
    files.push(file(`lib/f${i}.ts`));
    add(`lib/f${i}.ts`, "vendor/v.ts");
  }
  add("lib/f5.ts", "core/a.ts");
  return { files, edges };
}

function graphDb(
  g: FileDependencyGraph = graph(),
  nonPublicEdges: NonPublicMemberEdge[] = [],
  cochange: TemporalCochangeGraph = { meta: null, edges: [] },
  typeRows: unknown[] = [],
) {
  return {
    readFileDependencyGraph: vi.fn().mockResolvedValue(g),
    readNonPublicMemberEdges: vi.fn().mockResolvedValue(nonPublicEdges),
    readTemporalCochangeGraph: vi.fn().mockResolvedValue(cochange),
    readTypeNameRows: vi.fn().mockResolvedValue(typeRows),
  };
}

describe("ArchitectureReportOps#build", () => {
  it("returns component SDP violations with coupling evidence and the file edges carrying them, most severe first", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), {});

    expect(report.violations).toEqual([
      {
        detector: "stableDependencies",
        sourceComponent: "base",
        targetComponent: "lib",
        evidence: {
          sourceInstability: 1 / 7,
          targetInstability: 5 / 9,
          instabilityDelta: 5 / 9 - 1 / 7,
          sourceAfferentCount: 6,
          sourceEfferentCount: 1,
          targetAfferentCount: 4,
          targetEfferentCount: 5,
          callWeight: 3,
          directoryRelation: "disjoint",
          fileEdgeCount: 1,
          fileEdges: [{ sourceRelPath: "base/a.ts", targetRelPath: "lib/f4.ts", callWeight: 3 }],
        },
      },
      {
        detector: "stableDependencies",
        sourceComponent: "core",
        targetComponent: "lib",
        evidence: {
          sourceInstability: 2 / 9,
          targetInstability: 5 / 9,
          instabilityDelta: 5 / 9 - 2 / 9,
          sourceAfferentCount: 7,
          sourceEfferentCount: 2,
          targetAfferentCount: 4,
          targetEfferentCount: 5,
          callWeight: 3,
          directoryRelation: "disjoint",
          fileEdgeCount: 2,
          fileEdges: [
            { sourceRelPath: "core/a.ts", targetRelPath: "lib/f1.ts", callWeight: 2 },
            { sourceRelPath: "core/b.ts", targetRelPath: "lib/f2.ts", callWeight: 1 },
          ],
        },
      },
      // The same core⇄lib cycle the SDP detector reads as root cause, as the
      // layering detector (bd tea-rags-mcp-r8hme.22) reports it: a knot whose
      // canonical cut takes the core → lib flow (bd tea-rags-mcp-r8hme.42),
      // beside its minority-weight back-edge.
      {
        detector: "layering",
        kind: "knot",
        components: ["core", "lib"],
        evidence: {
          feedbackArcSet: [
            {
              sourceComponent: "core",
              targetComponent: "lib",
              callWeight: 3,
              fileEdges: [
                { sourceRelPath: "core/a.ts", targetRelPath: "lib/f1.ts", callWeight: 2 },
                { sourceRelPath: "core/b.ts", targetRelPath: "lib/f2.ts", callWeight: 1 },
              ],
            },
          ],
          cutEdgeCount: 1,
          levelsAfterCut: 2,
          memberCount: 2,
          drillDown: {
            knotOf: "core",
            hint: "call get_architecture_report with knotOf to page every member and cut edge of this knot",
          },
          instabilitySpread: 0.333,
        },
      },
      {
        detector: "layering",
        kind: "backEdge",
        sourceComponent: "lib",
        targetComponent: "core",
        evidence: {
          callWeight: 1,
          counterFlowWeight: 3,
          fileEdgeCount: 1,
          fileEdges: [{ sourceRelPath: "lib/f5.ts", targetRelPath: "core/a.ts", callWeight: 1 }],
        },
      },
      // `app` and `other` hang off the side of the stack: nothing depends on
      // either, and neither reaches the top level the way `users` does.
      {
        detector: "layering",
        kind: "island",
        component: "app",
        evidence: { height: 2, depth: 0, afferentCount: 0, instability: 1 },
      },
      {
        detector: "layering",
        kind: "island",
        component: "other",
        evidence: { height: 2, depth: 0, afferentCount: 0, instability: 1 },
      },
    ]);
  });

  it("returns root causes grouped by unstable target component, flagging a cycle with its dependents", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), {});

    expect(report.rootCauses).toEqual([
      {
        detector: "stableDependencies",
        targetComponent: "lib",
        targetInstability: 5 / 9,
        violationCount: 2,
        maxInstabilityDelta: 5 / 9 - 1 / 7,
        sources: ["base", "core"],
        cycleWithDependents: true,
      },
    ]);
  });

  // The response shape must carry what the detector's evidence rows carry: the
  // names an edge's imports bind are how a reader tells the four callWeight-0
  // causes apart (bd tea-rags-mcp-89k7k.2). The names here are the live shape
  // that started the bead — app.ts's runtime + type import of drift.
  it("carries the file edges' export names through to the SDP evidence (tea-rags-mcp-89k7k.2)", async () => {
    const g = graph();
    g.edges[2] = {
      sourceRelPath: "base/a.ts",
      targetRelPath: "lib/f4.ts",
      callWeight: 3,
      importedExportNames: ["formatIndexDriftReport", "IndexDriftReporter"],
    };

    const report = await new ArchitectureReportOps().build(graphDb(g), {});
    const base = report.violations.find((v) => v.detector === "stableDependencies" && v.sourceComponent === "base");

    expect(base && "evidence" in base ? base.evidence.fileEdges : []).toEqual([
      {
        sourceRelPath: "base/a.ts",
        targetRelPath: "lib/f4.ts",
        callWeight: 3,
        importedExportNames: ["formatIndexDriftReport", "IndexDriftReporter"],
      },
    ]);
  });

  // The response shape must carry the detector's composition-root annotation:
  // an SDP delta sourced from the declared composition root is triage data (bd
  // tea-rags-mcp-r8hme.51) — the mapper dropping it would repeat the 0qaht.45
  // gap, so the survival is pinned by exact shape.
  it("carries the composition-root annotation through to the SDP evidence (tea-rags-mcp-r8hme.51)", async () => {
    const files = [file("src/bootstrap/a.ts"), file("src/bootstrap/b.ts"), file("vendor/v.ts"), file("other/o.ts")];
    const edges: FileDependencyGraph["edges"] = [
      { sourceRelPath: "src/bootstrap/a.ts", targetRelPath: "src/core/lib/f1.ts", callWeight: 2 },
      { sourceRelPath: "src/bootstrap/b.ts", targetRelPath: "src/core/lib/f2.ts", callWeight: 1 },
      { sourceRelPath: "src/core/lib/f1.ts", targetRelPath: "vendor/v.ts", callWeight: 1 },
      { sourceRelPath: "src/core/lib/f2.ts", targetRelPath: "vendor/v.ts", callWeight: 1 },
      { sourceRelPath: "src/core/lib/f3.ts", targetRelPath: "vendor/v.ts", callWeight: 1 },
      { sourceRelPath: "src/core/lib/f4.ts", targetRelPath: "vendor/v.ts", callWeight: 1 },
      { sourceRelPath: "src/core/lib/f5.ts", targetRelPath: "vendor/v.ts", callWeight: 1 },
      { sourceRelPath: "other/o.ts", targetRelPath: "src/core/lib/f3.ts", callWeight: 1 },
    ];
    // Six importers give src/bootstrap the support floor room: Ca 6, Ce 2,
    // I = 2/8 against the lib's 5/8 — the same uphill shape the detector-level
    // fixture uses.
    for (let i = 1; i <= 6; i++) {
      files.push(file(`app/c${i}.ts`));
      edges.push({ sourceRelPath: `app/c${i}.ts`, targetRelPath: "src/bootstrap/b.ts", callWeight: 1 });
    }
    for (let i = 1; i <= 5; i++) files.push(file(`src/core/lib/f${i}.ts`));
    const g: FileDependencyGraph = { files, edges };

    const report = await new ArchitectureReportOps().build(graphDb(g), {});
    const violation = report.violations.find((v) => v.detector === "stableDependencies");

    expect(violation && "sourceComponent" in violation ? violation.sourceComponent : undefined).toBe("src/bootstrap");
    expect(
      violation && "evidence" in violation
        ? violation.evidence
        : expect.fail("no stableDependencies violation"),
    ).toEqual({
      sourceInstability: 2 / 8,
      targetInstability: 5 / 8,
      instabilityDelta: 5 / 8 - 2 / 8,
      sourceAfferentCount: 6,
      sourceEfferentCount: 2,
      targetAfferentCount: 3,
      targetEfferentCount: 5,
      callWeight: 3,
      directoryRelation: "disjoint",
      fileEdgeCount: 2,
      compositionRoot: true,
      fileEdges: [
        { sourceRelPath: "src/bootstrap/a.ts", targetRelPath: "src/core/lib/f1.ts", callWeight: 2 },
        { sourceRelPath: "src/bootstrap/b.ts", targetRelPath: "src/core/lib/f2.ts", callWeight: 1 },
      ],
    });
  });

  it("summarises the component graph, what was judged and excluded, naming each exclusion reason", async () => {
    const g = graph();
    const report = await new ArchitectureReportOps().build(graphDb(g), {});

    expect(report.summary.stableDependencies).toEqual({
      tolerance: 0.2,
      minConnectionCount: 5,
      edgeCount: g.edges.length,
      componentCount: 7,
      moduleComponentCount: 0,
      directoryComponentCount: 7,
      componentEdgeCount: 7,
      judgedEdgeCount: 6,
      violationCount: 2,
      rootCauseCount: 1,
      excluded: {
        selfEdges: 0,
        unwalkedEndpoints: 0,
        intraComponent: 0,
        facadeAggregations: 0,
        containment: 0,
        lowConnectionCount: 1,
      },
      exclusionReasons: {
        facadeAggregations: "facade aggregation: a module facade re-exporting a descendant module's facade",
        containment:
          "containment: a component depending on a component nested inside its directory - composition, not a peer dependency",
      },
    });
    expect(report.pathPattern).toBeUndefined();
  });

  it("scopes the judged dependencies to those carried by a source file matching pathPattern", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), { pathPattern: "base/**" });

    expect(report.pathPattern).toBe("base/**");
    expect(
      report.violations
        .filter((v) => v.detector === "stableDependencies")
        .map((v) => (v.detector === "stableDependencies" ? v.sourceComponent : v.sourceRelPath)),
    ).toEqual(["base"]);
    expect(report.summary.stableDependencies.outOfScopeEdgeCount).toBe(6);
  });

  it("scopes the layering findings to pathPattern while levelling the whole graph (bd tea-rags-mcp-r8hme.33)", async () => {
    const whole = await new ArchitectureReportOps().build(graphDb(), {});
    const scoped = await new ArchitectureReportOps().build(graphDb(), { pathPattern: "lib/**" });

    // The core⇄lib knot has lib as a member and its back-edge is carried by
    // lib/f5.ts; the app and other islands are out of scope.
    expect(scoped.violations.filter((v) => v.detector === "layering").map((v) => v.kind)).toEqual(["knot", "backEdge"]);
    expect(scoped.summary.layering).toMatchObject({
      levelCount: whole.summary.layering.levelCount,
      coverage: whole.summary.layering.coverage,
      knotCount: 1,
      backEdgeCount: 1,
      islandCount: 0,
      violationCount: 2,
      outOfScopeFindingCount: 2,
    });
    expect(whole.summary.layering.outOfScopeFindingCount).toBeUndefined();
  });

  it("projects a scoped knot onto its in-scope members in the public evidence (bd tea-rags-mcp-r8hme.33)", async () => {
    const scoped = await new ArchitectureReportOps().build(graphDb(), { pathPattern: "lib/**" });
    const whole = await new ArchitectureReportOps().build(graphDb(), {});

    const knot = scoped.violations.find((v) => v.detector === "layering" && v.kind === "knot");
    // core owns no lib/** file; the cut edge core → lib is carried by
    // core/a.ts and core/b.ts, so it rides out of scope.
    expect(knot).toMatchObject({
      components: ["lib"],
      evidence: { outOfScopeMemberCount: 1, outOfScopeFeedbackEdgeCount: 1 },
    });
    const wholeKnot = whole.violations.find((v) => v.detector === "layering" && v.kind === "knot");
    expect(wholeKnot).toBeDefined();
    expect(wholeKnot && "evidence" in wholeKnot ? wholeKnot.evidence : {}).not.toHaveProperty("outOfScopeMemberCount");
  });

  it("caps violations and root causes at limit while the summary keeps the totals", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), { limit: 1 });

    // The cap is per detector: the layering knot joins the SDP finding at one each.
    expect(report.violations.filter((v) => v.detector === "stableDependencies")).toHaveLength(1);
    expect(report.violations.filter((v) => v.detector === "layering")).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({ sourceComponent: "base" });
    expect(report.rootCauses).toHaveLength(1);
    expect(report.summary.stableDependencies.violationCount).toBe(2);
  });

  it("reports an empty graph as nothing read, not as a clean bill of health in disguise", async () => {
    const report = await new ArchitectureReportOps().build(graphDb({ files: [], edges: [] }), {});

    expect(report.violations).toEqual([]);
    expect(report.rootCauses).toEqual([]);
    expect(report.summary.stableDependencies.edgeCount).toBe(0);
  });

  /**
   * INVARIANT CHANGED (bd tea-rags-mcp-r8hme.30): the layering detector judges
   * the DOMAIN partition — every directory with a facade file, adoption
   * notwithstanding. `lang/` has a facade one file imports, so the
   * facade-adoption partition leaves `lang/walker.ts`, `lang/resolver.ts` and
   * the `lang/strategies/` subtree to their own directory components and
   * levels them separately; the domain partition collapses them into `lang`.
   * `kernel/` has three facade importers — a judged module under both.
   */
  function domainFixture(): FileDependencyGraph {
    const files = [
      "kernel/index.ts",
      "kernel/core.ts",
      "lang/index.ts",
      "lang/walker.ts",
      "lang/resolver.ts",
      "lang/strategies/strat.ts",
      "app/main.ts",
    ].map(file);
    const edges = [
      { sourceRelPath: "app/main.ts", targetRelPath: "lang/walker.ts", callWeight: 1 },
      { sourceRelPath: "lang/walker.ts", targetRelPath: "lang/strategies/strat.ts", callWeight: 1 },
      { sourceRelPath: "lang/walker.ts", targetRelPath: "kernel/index.ts", callWeight: 2 },
      { sourceRelPath: "lang/resolver.ts", targetRelPath: "kernel/index.ts", callWeight: 1 },
      { sourceRelPath: "lang/strategies/strat.ts", targetRelPath: "kernel/core.ts", callWeight: 1 },
    ];
    return { files, edges };
  }

  it("judges layering on the domain partition and reports both partitions' counts", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(domainFixture()), {});

    // Domain partition: kernel, lang, app — three levels, kernel the foundation.
    // Facade-adoption partition: kernel, lang, lang/strategies, app — the
    // intra-domain walker→strategies edge levels strategies below lang, one
    // level deeper.
    expect(report.summary.layering).toMatchObject({
      componentCount: 3,
      levelCount: 3,
      violationCount: 0,
      facadePartition: { componentCount: 4, levelCount: 4 },
    });
  });

  it("builds the layer map over the same domain partition the detector judges", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(domainFixture()), {
      layerMap: { scopePathPattern: "lang/**", granularity: "file" },
    });

    // The files of `lang/` leveled on the RAW file edges (the partition
    // excludes intra-component edges); kernel sits outside the scope, its
    // global level 0 riding on every boundary edge. depth counts from the
    // roots of the INDUCED graph: walker and resolver depend on nothing
    // inside the scope.
    const map = report.layerMap;
    expect(map?.granularity).toBe("file");
    expect(map?.nodes).toEqual([
      { node: "lang/index.ts", level: 0, depth: 0, inKnot: false, innerAfferentCount: 0, innerEfferentCount: 0 },
      { node: "lang/resolver.ts", level: 0, depth: 0, inKnot: false, innerAfferentCount: 0, innerEfferentCount: 0 },
      {
        node: "lang/strategies/strat.ts",
        level: 0,
        depth: 1,
        inKnot: false,
        innerAfferentCount: 1,
        innerEfferentCount: 0,
      },
      { node: "lang/walker.ts", level: 1, depth: 0, inKnot: false, innerAfferentCount: 0, innerEfferentCount: 1 },
    ]);
    expect(map?.boundaryOut.map((e) => [e.sourceNode, e.externalComponent, e.externalLevel, e.callWeight])).toEqual([
      ["lang/resolver.ts", "kernel", 0, 1],
      ["lang/strategies/strat.ts", "kernel", 0, 1],
      ["lang/walker.ts", "kernel", 0, 2],
    ]);
  });
});

/**
 * `mod/` has a facade three of four external importers use; `ext/d.ts` reaches
 * `mod/inner.ts` (which the facade does not import) and `ext/e.ts` reaches
 * `mod/shown.ts` (which it re-exports). `raw/` has a facade nobody uses.
 */
function facadeGraph(): FileDependencyGraph {
  const files = ["mod/index.ts", "mod/inner.ts", "mod/shown.ts", "raw/index.ts", "raw/r.ts"].map(file);
  const edges: FileDependencyGraph["edges"] = [
    { sourceRelPath: "mod/index.ts", targetRelPath: "mod/shown.ts", callWeight: 0 },
  ];
  for (const s of ["ext/a.ts", "ext/b.ts", "ext/c.ts", "ext/f.ts"]) {
    files.push(file(s));
    edges.push({ sourceRelPath: s, targetRelPath: "mod/index.ts", callWeight: 0 });
    edges.push({ sourceRelPath: s, targetRelPath: "raw/r.ts", callWeight: 0 });
  }
  files.push(file("ext/d.ts"), file("ext/e.ts"));
  edges.push({ sourceRelPath: "ext/d.ts", targetRelPath: "mod/inner.ts", callWeight: 1 });
  edges.push({ sourceRelPath: "ext/e.ts", targetRelPath: "mod/shown.ts", callWeight: 0 });
  return { files, edges };
}

describe("ArchitectureReportOps#build — leakingAbstraction (bd tea-rags-mcp-jetrd)", () => {
  it("reports both leak kinds with per-line evidence after the SDP findings", async () => {
    // mod/shown.ts imports the external bypasser ext/e.ts back — the module's
    // graph threads out to the violating importer, the shape the re-export
    // recipe turns into a cycle (bd tea-rags-mcp-89k7k.17).
    const g = facadeGraph();
    g.edges.push({ sourceRelPath: "mod/shown.ts", targetRelPath: "ext/e.ts", callWeight: 0 });
    const report = await new ArchitectureReportOps().build(graphDb(g), {});
    const evidence = {
      moduleDir: "mod",
      facadeRelPath: "mod/index.ts",
      adoption: 4 / 6,
      facadeImporterCount: 4,
      deepImporterCount: 2,
    };

    expect(report.violations.filter((v) => v.detector === "leakingAbstraction")).toEqual([
      {
        detector: "leakingAbstraction",
        kind: "internal-reach",
        sourceRelPath: "ext/d.ts",
        targetRelPath: "mod/inner.ts",
        evidence: { ...evidence, callWeight: 1, kindBasis: "file-rule", reExportUnsafe: false },
      },
      {
        detector: "leakingAbstraction",
        kind: "bypass",
        sourceRelPath: "ext/e.ts",
        targetRelPath: "mod/shown.ts",
        evidence: {
          ...evidence,
          callWeight: 0,
          kindBasis: "file-rule",
          reExportUnsafe: true,
          reExportCyclePath: ["mod/index.ts", "mod/shown.ts", "ext/e.ts"],
        },
      },
    ]);
    expect(report.rootCauses.filter((r) => r.detector === "leakingAbstraction")).toEqual([
      {
        detector: "leakingAbstraction",
        ...evidence,
        violationCount: 2,
        bypassCount: 1,
        internalReachCount: 1,
        sources: ["ext/d.ts", "ext/e.ts"],
      },
    ]);
  });

  it("summarises modules, kinds and named exclusion reasons, listing active and unadopted modules", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(facadeGraph()), { pathPattern: "ext/**" });
    const summary = report.summary.leakingAbstraction;

    expect(summary).toMatchObject({
      adoptionThreshold: 0.5,
      minExternalImporters: 3,
      violationCount: 2,
      rootCauseCount: 1,
      violationsByKind: { bypass: 1, internalReach: 1 },
      moduleCount: 2,
      activeModuleCount: 1,
      excludedModules: { facadeNotAdopted: 1, tooFewImporters: 0, languageEnforced: 0 },
      outOfScopeEdgeCount: 1,
    });
    expect(Object.keys(summary.exclusionReasons).sort()).toEqual([
      "facade-not-adopted",
      "language-enforced",
      "too-few-importers",
    ]);
    expect(summary.activeModules.map((m) => m.moduleDir)).toEqual(["mod"]);
    expect(summary.notAdoptedModules).toEqual([
      {
        moduleDir: "raw",
        facadeRelPath: "raw/index.ts",
        externalImporterCount: 4,
        facadeImporterCount: 0,
        deepImporterCount: 4,
        adoption: 0,
      },
    ]);
  });

  it("reports the majority method with no separability when the population is too small for Otsu", async () => {
    const summary = (await new ArchitectureReportOps().build(graphDb(facadeGraph()), {})).summary.leakingAbstraction;

    expect(summary.adoptionThresholdMethod).toBe("majority");
    expect(summary.adoptionThreshold).toBe(0.5);
    expect(summary).not.toHaveProperty("adoptionSeparability");
  });

  it("reports the Otsu threshold and its separability rounded to 3 decimals", async () => {
    // Eight modules, adoption 0 0 0 0.1 0.9 1 1 1 → Otsu cut 0.5, four admitted.
    const files: FileDependencyGraph["files"] = [];
    const edges: FileDependencyGraph["edges"] = [];
    const shapes: [number, number][] = [
      [0, 3],
      [0, 3],
      [0, 4],
      [1, 9],
      [9, 1],
      [3, 0],
      [3, 0],
      [4, 0],
    ];
    shapes.forEach(([facade, deep], m) => {
      files.push(file(`m${m}/index.ts`), file(`m${m}/x.ts`));
      for (let i = 0; i < facade + deep; i++) {
        files.push(file(`u${m}/f${i}.ts`));
        edges.push({
          sourceRelPath: `u${m}/f${i}.ts`,
          targetRelPath: `m${m}/${i < facade ? "index" : "x"}.ts`,
          callWeight: 0,
        });
      }
    });
    const summary = (await new ArchitectureReportOps().build(graphDb({ files, edges }), {})).summary.leakingAbstraction;

    expect(summary.adoptionThresholdMethod).toBe("otsu");
    expect(summary.adoptionThreshold).toBeCloseTo(0.5, 12);
    expect(summary.adoptionSeparability).toBeDefined();
    expect(summary.adoptionSeparability).toBe(Math.round((summary.adoptionSeparability ?? 0) * 1000) / 1000);
    expect(summary.activeModuleCount).toBe(4);
  });

  it("caps each detector's violations at limit independently", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(facadeGraph()), { limit: 1 });

    expect(report.violations.filter((v) => v.detector === "leakingAbstraction")).toHaveLength(1);
    expect(report.summary.leakingAbstraction.violationCount).toBe(2);
  });

  it("carries the imported and non-exported names as evidence when the edges record them (bd tea-rags-mcp-r8hme.2)", async () => {
    const g = facadeGraph();
    g.edges = g.edges.map((e) => {
      if (e.sourceRelPath === "mod/index.ts") return { ...e, reexportedExportNames: ["Shown"] };
      if (e.sourceRelPath === "ext/e.ts") return { ...e, importedExportNames: ["Shown", "hidden"] };
      return e;
    });
    const report = await new ArchitectureReportOps().build(graphDb(g), {});

    const leak = report.violations.find((v) => v.detector === "leakingAbstraction" && v.sourceRelPath === "ext/e.ts");
    expect(leak).toMatchObject({
      kind: "internal-reach",
      evidence: { importedNames: ["Shown", "hidden"], nonExportedNames: ["hidden"] },
    });
    const unnamed = report.violations.find(
      (v) => v.detector === "leakingAbstraction" && v.sourceRelPath === "ext/d.ts",
    );
    expect(unnamed?.evidence).not.toHaveProperty("importedNames");
    expect(unnamed?.evidence).not.toHaveProperty("nonExportedNames");
  });

  it("carries kindBasis in the evidence: names for a names-certified bypass, file-rule when the file rule decided (bd tea-rags-mcp-0qaht.45)", async () => {
    // Names-certified bypass: the deep import takes only what the facade re-exports.
    const named = facadeGraph();
    named.edges = named.edges.map((e) => {
      if (e.sourceRelPath === "mod/index.ts") return { ...e, reexportedExportNames: ["Shown"] };
      if (e.sourceRelPath === "ext/e.ts") return { ...e, importedExportNames: ["Shown"] };
      return e;
    });
    const namedReport = await new ArchitectureReportOps().build(graphDb(named), {});
    expect(
      namedReport.violations.find((v) => v.detector === "leakingAbstraction" && v.sourceRelPath === "ext/e.ts"),
    ).toMatchObject({ kind: "bypass", evidence: { kindBasis: "names" } });

    // File rule: no names recorded on either side — the file-level rule decided.
    const plainReport = await new ArchitectureReportOps().build(graphDb(facadeGraph()), {});
    expect(
      plainReport.violations.find((v) => v.detector === "leakingAbstraction" && v.sourceRelPath === "ext/e.ts"),
    ).toMatchObject({ kind: "bypass", evidence: { kindBasis: "file-rule" } });
  });
});

describe("ArchitectureReportOps#build — conventionPrivacy (bd tea-rags-mcp-r8hme.1)", () => {
  const underscoreEdge: NonPublicMemberEdge = {
    sourceRelPath: "app/views.py",
    sourceSymbolId: "render",
    targetRelPath: "pkg/repo.py",
    targetSymbolId: "Repo#_load",
    targetShortName: "_load",
    targetVisibility: null,
    targetLanguage: "python",
    callExpression: "repo._load()",
  };

  it("asks only for the convention-privacy languages and reports each leak with symbol evidence", async () => {
    const db = graphDb(facadeGraph(), [underscoreEdge]);
    const report = await new ArchitectureReportOps().build(db, {});

    expect(db.readNonPublicMemberEdges).toHaveBeenCalledWith(["python", "ruby"]);
    expect(
      report.violations.filter((v) => v.detector === "leakingAbstraction" && v.kind === "conventionPrivacy"),
    ).toEqual([
      {
        detector: "leakingAbstraction",
        kind: "conventionPrivacy",
        sourceRelPath: "app/views.py",
        targetRelPath: "pkg/repo.py",
        evidence: { sourceSymbolId: "render", targetSymbolId: "Repo#_load", rule: "python-underscore" },
      },
    ]);
    expect(report.summary.leakingAbstraction).toMatchObject({
      violationCount: 3,
      violationsByKind: { bypass: 1, internalReach: 1, conventionPrivacy: 1 },
      conventionPrivacy: { candidateEdgeCount: 1, violationsByRule: { pythonUnderscore: 1, rubySendPrivate: 0 } },
    });
  });
});

/**
 * Silent coupling (bd tea-rags-mcp-b4dcz): `lib/hub.ts` and `app/s1.ts`
 * co-change 10 times out of 10 with no edge between them; `lib/hub.ts` and
 * `web/s2.ts` just as reliably, but an import joins them; `docs/guide.md` and
 * `app/s1.ts` are documentation-coupled and never judged.
 */
/**
 * The walked files the silent-coupling pairs below name. The component SDP
 * fixture `graph()` (bd tea-rags-mcp-r8hme.7) no longer contains them, and a
 * co-change endpoint the structural graph never walked is excluded, so these
 * tests keep the graph they were written against.
 */
function silentCouplingGraph(): FileDependencyGraph {
  const files = [file("lib/hub.ts"), file("app/s1.ts"), file("web/s2.ts"), file("app/private.ts")];
  const edges: FileDependencyGraph["edges"] = [];
  const add = (sourceRelPath: string, targetRelPath: string, callWeight = 1) => {
    edges.push({ sourceRelPath, targetRelPath, callWeight });
  };
  for (const s of ["app/s1.ts", "web/s2.ts"]) {
    add(s, "lib/hub.ts", 2);
    for (let i = 1; i <= 5; i++) {
      files.push(file(`${s}.in${i}.ts`));
      add(`${s}.in${i}.ts`, s);
    }
  }
  add("lib/hub.ts", "app/s1.ts");
  add("app/s1.ts", "app/private.ts");
  for (let i = 1; i <= 4; i++) {
    files.push(file(`vendor/h${i}.ts`), file(`vendor/p${i}.ts`));
    add("lib/hub.ts", `vendor/h${i}.ts`);
    add("app/private.ts", `vendor/p${i}.ts`);
  }
  return { files, edges };
}

function cochangeGraph(): TemporalCochangeGraph {
  const pair = (relPathA: string, relPathB: string, structurallyLinked: boolean): TemporalCochangeEdgeWithLinkage => ({
    relPathA,
    relPathB,
    support: 10,
    confidenceAB: 1,
    confidenceBA: 1,
    lift: 8,
    lastCoChangeAt: 1_700_000_000,
    sampleCommits: ["c2", "c1"],
    structurallyLinked,
  });
  return {
    meta: {
      head: "abc123",
      fingerprint: "fp",
      builtAt: 1_700_000_100,
      windowSince: 1_690_000_000,
      commitCount: 120,
      bundleCount: 100,
      admittedBundleCount: 96,
      maxFilesPerBundle: 18,
      minSupport: 2,
      maxPartnersPerFile: 20,
      sessionGapMinutes: 30,
    },
    edges: [
      pair("app/s1.ts", "lib/hub.ts", false),
      pair("lib/hub.ts", "web/s2.ts", true),
      pair("app/s1.ts", "docs/guide.md", false),
    ],
  };
}

describe("ArchitectureReportOps#build — silentCoupling (bd tea-rags-mcp-b4dcz)", () => {
  it("reports a strong unlinked co-change pair after the other detectors, with its evidence", async () => {
    const db = graphDb(silentCouplingGraph(), [], cochangeGraph());
    const report = await new ArchitectureReportOps().build(db, {});

    expect(db.readTemporalCochangeGraph).toHaveBeenCalledTimes(1);
    const silent = report.violations.filter((v) => v.detector === "silentCoupling");
    expect(silent).toEqual([
      {
        detector: "silentCoupling",
        sourceRelPath: "app/s1.ts",
        targetRelPath: "lib/hub.ts",
        evidence: {
          support: 10,
          confidenceAB: 1,
          confidenceBA: 1,
          lift: 8,
          strength: expect.closeTo(1 / (1 + 1.96 ** 2 / 10), 12),
          lastCoChangeAt: 1_700_000_000,
          sampleCommits: ["c2", "c1"],
          structuralVisibility: "both-walked",
          directoryRelation: "disjoint",
        },
      },
    ]);
    // Silent coupling comes after every detector except layering, the newest.
    const detectors = report.violations.map((v) => v.detector);
    expect(new Set(detectors.slice(detectors.indexOf("silentCoupling") + 1))).toEqual(new Set(["layering"]));
  });

  it("summarises the build, the adaptive cut and the exclusions, documentation included", async () => {
    const summary = (await new ArchitectureReportOps().build(graphDb(silentCouplingGraph(), [], cochangeGraph()), {}))
      .summary.silentCoupling;

    expect(summary).toMatchObject({
      built: true,
      build: { head: "abc123", commitCount: 120, sessionGapMinutes: 30 },
      pairCount: 3,
      candidateCount: 2,
      strongCount: 2,
      strongLinkedCount: 1,
      violationCount: 1,
      strengthThreshold: 0.5,
      strengthThresholdMethod: "majority",
      excluded: { documentationEndpoints: 1 },
    });
    // A no-symbol endpoint is judged since type-only imports are file edges
    // (bd tea-rags-mcp-r8hme.12): no counter, no reason to explain.
    expect(summary.excluded).not.toHaveProperty("noSymbolEndpoints");
    expect(summary).not.toHaveProperty("exclusionReasons");
  });

  /**
   * bd tea-rags-mcp-rbnkp: a `.tsx` and the `.module.css` it imports co-change,
   * and the codegraph has no edge for it because an asset is no file node. The
   * importer's declared specifiers link the pair; a pair nothing imports stays.
   */
  it("reads the walked endpoint's import specifiers to link a one-walked pair it imports", async () => {
    const base = cochangeGraph();
    const assetPair = (relPathA: string, relPathB: string): TemporalCochangeEdgeWithLinkage => ({
      ...base.edges[0],
      relPathA,
      relPathB,
      structurallyLinked: false,
    });
    const cochange: TemporalCochangeGraph = {
      ...base,
      edges: [
        ...base.edges,
        assetPair("app/s1.module.css", "app/s1.ts"),
        assetPair("config/frontend.en.yml", "web/s2.ts"),
      ],
    };
    const readImportSpecifiers = vi.fn().mockResolvedValue(
      new Map([
        ["app/s1.ts", ["../lib/hub.js", "./s1.module.css"]],
        ["web/s2.ts", ["../lib/hub.js"]],
      ]),
    );

    const report = await new ArchitectureReportOps().build(
      graphDb(silentCouplingGraph(), [], cochange),
      {},
      readImportSpecifiers,
    );

    expect(readImportSpecifiers).toHaveBeenCalledTimes(1);
    expect([...readImportSpecifiers.mock.calls[0][0]].sort()).toEqual(["app/s1.ts", "web/s2.ts"]);
    const silent = report.violations.filter((v) => v.detector === "silentCoupling");
    expect(silent.map((v) => `${v.sourceRelPath}|${v.targetRelPath}`)).toEqual([
      "app/s1.ts|lib/hub.ts",
      "config/frontend.en.yml|web/s2.ts",
    ]);
    expect(report.summary.silentCoupling).toMatchObject({ strongLinkedCount: 2, violationCount: 2 });
  });

  it("reads no specifiers when no violation has an unwalked endpoint", async () => {
    const readImportSpecifiers = vi.fn();

    await new ArchitectureReportOps().build(
      graphDb(silentCouplingGraph(), [], cochangeGraph()),
      {},
      readImportSpecifiers,
    );

    expect(readImportSpecifiers).not.toHaveBeenCalled();
  });

  it("says the co-change graph is not built rather than reporting a clean history", async () => {
    const summary = (await new ArchitectureReportOps().build(graphDb(), {})).summary.silentCoupling;

    expect(summary.built).toBe(false);
    expect(summary.pairCount).toBe(0);
  });
});

describe("ArchitectureReportOps#build — splitMerge (bd tea-rags-mcp-c3v6o)", () => {
  /**
   * The default `graph()` partition: plain directories, so `core` holds
   * core/a.ts and core/b.ts, `lib` holds lib/f1..f5. Thirty admitted bundles
   * touch core/a.ts AND lib/f1.ts; two more touch core alone — one unit of
   * change across two components, at Wilson strength 30/32.
   */
  function mergingBundles(): ReadonlyMap<number, readonly string[]> {
    return new Map([
      ...Array.from({ length: 30 }, (_, id) => [id, ["core/a.ts", "lib/f1.ts"]] as const),
      ...Array.from({ length: 2 }, (_, i) => [30 + i, ["core/a.ts", "core/b.ts"]] as const),
    ]);
  }

  it("renders the block beside silentCoupling with provenance from the build meta and the merge verdicts", async () => {
    const cochange: TemporalCochangeGraph = { ...cochangeGraph(), edges: [], bundles: mergingBundles() };
    const report = await new ArchitectureReportOps().build(graphDb(graph(), [], cochange), {});

    expect(report.summary.splitMerge).toEqual({
      built: true,
      head: "abc123",
      builtAt: 1_700_000_100,
      sessionGapMinutes: 30,
      verdicts: {
        splitCandidates: [],
        mergeCandidates: [
          // Strength rounded to 3 decimals, like every summary number.
          { componentA: "core", componentB: "lib", support: 30, strength: 0.886, changesA: 32, changesB: 30 },
        ],
        threshold: 0.5,
        thresholdMethod: "majority",
        excluded: { unpartitionedEndpoints: 0, crossComponentPairs: 0 },
      },
    });
  });

  it("degrades to built:false when the bundle table is empty or the read carries no membership", async () => {
    const emptyTable = (
      await new ArchitectureReportOps().build(graphDb(graph(), [], { ...cochangeGraph(), bundles: new Map() }), {})
    ).summary.splitMerge;
    expect(emptyTable).toEqual({
      built: false,
      reason: "noBundleMembership",
      head: "abc123",
      builtAt: 1_700_000_100,
      sessionGapMinutes: 30,
    });

    // A read with no `bundles` at all (a fixture, or a daemon from an older
    // build) is the same silence — never zeros posing as verdicts.
    const noMembership = (await new ArchitectureReportOps().build(graphDb(graph(), [], cochangeGraph()), {})).summary
      .splitMerge;
    expect(noMembership).toEqual(emptyTable);

    const noBuild = (await new ArchitectureReportOps().build(graphDb(), {})).summary.splitMerge;
    expect(noBuild).toEqual({ built: false, reason: "noCochangeBuild" });
  });
});

/**
 * bd tea-rags-mcp-r8hme.13: a co-change pair a SPECIFIC shared neighbour
 * explains leaves the violations and is counted under `excluded`, with the
 * reason named, the adaptive cut reported like the strength one, and the pair
 * listed with `evidence.explainedBy`. `proto/protocol.ts` (fanIn 2) explains
 * client ↔ server; `lib/kernel.ts`, imported by 40 of 42 files, explains no
 * w/p ↔ w/q pair.
 */
describe("ArchitectureReportOps#build — silentCoupling shared-neighbour explanation (bd tea-rags-mcp-r8hme.13)", () => {
  function explainedGraphs(): { g: FileDependencyGraph; cochange: TemporalCochangeGraph } {
    const hubPairs = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`w/p${i}.ts`, `w/q${i}.ts`] as const);
    const importers = ["a/client.ts", "b/server.ts", ...hubPairs.flat()];
    const fillers = Array.from({ length: 22 }, (_, i) => `z/f${i}.ts`);
    const files = ["lib/kernel.ts", "proto/protocol.ts", ...importers, ...fillers].map(file);
    const edges: FileDependencyGraph["edges"] = [
      ...[...importers, ...fillers].map((s) => ({ sourceRelPath: s, targetRelPath: "lib/kernel.ts", callWeight: 1 })),
      { sourceRelPath: "a/client.ts", targetRelPath: "proto/protocol.ts", callWeight: 1 },
      { sourceRelPath: "b/server.ts", targetRelPath: "proto/protocol.ts", callWeight: 1 },
    ];
    const base = cochangeGraph();
    const pairOf = (relPathA: string, relPathB: string): TemporalCochangeEdgeWithLinkage => ({
      ...base.edges[0],
      relPathA,
      relPathB,
      structurallyLinked: false,
    });
    return {
      g: { files, edges },
      cochange: { ...base, edges: [pairOf("a/client.ts", "b/server.ts"), ...hubPairs.map(([p, q]) => pairOf(p, q))] },
    };
  }

  it("excludes the explained pair with its reason and lists it with the neighbour that explains it", async () => {
    const { g, cochange } = explainedGraphs();
    expect(g.files).toHaveLength(42);

    const report = await new ArchitectureReportOps().build(graphDb(g, [], cochange), {});

    const silent = report.violations.filter((v) => v.detector === "silentCoupling");
    expect(silent).toHaveLength(8);
    expect(silent.map((v) => v.sourceRelPath)).not.toContain("a/client.ts");
    const summary = report.summary.silentCoupling;
    expect(summary).toMatchObject({
      violationCount: 8,
      sharedNeighbourThresholdMethod: "otsu",
      excluded: { explainedBySharedNeighbour: 1 },
    });
    expect(summary.sharedNeighbourThreshold).toBeGreaterThan(Math.log(42 / 40));
    expect(summary.sharedNeighbourThreshold).toBeLessThan(Math.log(42 / 2));
    expect(summary.sharedNeighbourSeparability).toBeGreaterThan(0.9);
    expect(summary.exclusionReasons?.explainedBySharedNeighbour).toEqual(expect.any(String));
    expect(summary.explainedPairs).toEqual([
      {
        detector: "silentCoupling",
        sourceRelPath: "a/client.ts",
        targetRelPath: "b/server.ts",
        evidence: expect.objectContaining({
          support: 10,
          explainedBy: { relPath: "proto/protocol.ts", weight: Math.round(Math.log(42 / 2) * 1000) / 1000 },
        }),
      },
    ]);
  });

  it("names no exclusion reason and lists no pair when nothing is explained", async () => {
    const summary = ArchitectureReportOps.empty({}).summary.silentCoupling;

    expect(summary.excluded.explainedBySharedNeighbour).toBe(0);
    expect(summary.sharedNeighbourThresholdMethod).toBe("none");
    expect(summary).not.toHaveProperty("exclusionReasons");
    expect(summary).not.toHaveProperty("explainedPairs");
  });
});

describe("ArchitectureReportOps.empty", () => {
  it("reports an unbuilt silent-coupling summary too", () => {
    const summary = ArchitectureReportOps.empty({}).summary.silentCoupling;

    expect(summary.built).toBe(false);
    expect(summary.violationCount).toBe(0);
  });

  it("reports an empty leaking-abstraction summary too", () => {
    const summary = ArchitectureReportOps.empty({}).summary.leakingAbstraction;

    expect(summary.edgeCount).toBe(0);
    expect(summary.moduleCount).toBe(0);
    expect(summary.activeModules).toEqual([]);
  });

  it("is the report of a collection with no graph database: zero edges read", () => {
    const report = ArchitectureReportOps.empty({ pathPattern: "src/**" });

    expect(report.violations).toEqual([]);
    expect(report.rootCauses).toEqual([]);
    expect(report.pathPattern).toBe("src/**");
    expect(report.summary.stableDependencies.edgeCount).toBe(0);
    expect(report.summary.stableDependencies.judgedEdgeCount).toBe(0);
  });

  it("maps a scoped domain at file granularity, boundary edges carrying the outside component's global level (bd tea-rags-mcp-r8hme.26)", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), {
      layerMap: { scopePathPattern: "lib/**", granularity: "file" },
    });

    const map = report.layerMap!;
    expect(map.scope).toBe("lib/**");
    expect(map.granularity).toBe("file");
    expect(map.nodes.map((n) => n.node).sort()).toEqual([
      "lib/f1.ts",
      "lib/f2.ts",
      "lib/f3.ts",
      "lib/f4.ts",
      "lib/f5.ts",
    ]);
    // No file inside lib imports another — every file sits at the foundation of the induced stack.
    expect(map.levelCount).toBe(0);
    // The knot {core, lib} condenses to level 1 on the whole-repo stack: that is the global level boundary findings carry.
    expect(map.boundaryOut).toEqual([
      { sourceNode: "lib/f5.ts", externalComponent: "core", externalLevel: 1, callWeight: 1 },
      { sourceNode: "lib/f1.ts", externalComponent: "vendor", externalLevel: 0, callWeight: 1 },
      { sourceNode: "lib/f2.ts", externalComponent: "vendor", externalLevel: 0, callWeight: 1 },
      { sourceNode: "lib/f3.ts", externalComponent: "vendor", externalLevel: 0, callWeight: 1 },
      { sourceNode: "lib/f4.ts", externalComponent: "vendor", externalLevel: 0, callWeight: 1 },
      { sourceNode: "lib/f5.ts", externalComponent: "vendor", externalLevel: 0, callWeight: 1 },
    ]);
    // The upstream pulls the other way: core, base and other files reach into lib.
    expect(map.boundaryIn).toEqual([
      { targetNode: "lib/f4.ts", externalComponent: "base", externalLevel: 2, callWeight: 3 },
      { targetNode: "lib/f1.ts", externalComponent: "core", externalLevel: 1, callWeight: 2 },
      { targetNode: "lib/f2.ts", externalComponent: "core", externalLevel: 1, callWeight: 1 },
      { targetNode: "lib/f3.ts", externalComponent: "other", externalLevel: 2, callWeight: 1 },
    ]);
  });

  it("omits the layer map unless the request asks for one", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), {});

    expect(report).not.toHaveProperty("layerMap");
  });
});

/**
 * bd tea-rags-mcp-xb669.1: `domain:` judges one directory AS ITS OWN SYSTEM —
 * the induced subgraph (files under the root, edges with both endpoints
 * inside), every detector and metric recomputed inside it. Distinct from
 * `pathPattern`, which keeps whole-system metrics and only filters findings.
 * Edges crossing the domain border are kept as boundary findings naming the
 * external component and its level on the WHOLE-graph stack — a domain's
 * place in the system is the one thing an internal view cannot recompute.
 *
 * `d/` holds three facade directories (a, b, c — too few importers to be
 * adoption components, still domains); `a ⇄ b` cycles inside; `a → kernel`
 * leaves the domain; `app → b` enters it.
 */
function domainFixture(): FileDependencyGraph {
  const files = ["d/a/index.ts", "d/a/x.ts", "d/b/index.ts", "d/b/y.ts", "d/c/index.ts", "kernel/k.ts", "app/m.ts"].map(
    file,
  );
  const edges: FileDependencyGraph["edges"] = [
    { sourceRelPath: "d/b/y.ts", targetRelPath: "d/a/x.ts", callWeight: 1 },
    { sourceRelPath: "d/a/x.ts", targetRelPath: "d/b/y.ts", callWeight: 2 },
    { sourceRelPath: "d/c/index.ts", targetRelPath: "d/a/index.ts", callWeight: 1 },
    { sourceRelPath: "d/a/x.ts", targetRelPath: "kernel/k.ts", callWeight: 3 },
    { sourceRelPath: "app/m.ts", targetRelPath: "d/b/y.ts", callWeight: 1 },
  ];
  return { files, edges };
}

describe("ArchitectureReportOps#build — domain mode (bd tea-rags-mcp-xb669.1)", () => {
  it("judges a domain as its own system, keeping border edges with the outside component's global level", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(domainFixture()), { domain: "d" });

    // Inside: three components over three component deps; the whole graph
    // would also hold kernel and app (five). The a⇄b cycle is the domain's
    // own knot; d/c stacks one level above it. Outside: kernel condenses to
    // the foundation of the whole graph, app sits two levels up (it reaches
    // the d/a⇄d/b knot through d/b), so the border edges carry 0 and 2.
    expect(report.domain).toEqual({
      path: "d",
      componentCount: 3,
      levelCount: 2,
      boundaryOut: [{ innerComponent: "d/a", externalComponent: "kernel", externalLevel: 0, callWeight: 3 }],
      boundaryIn: [{ innerComponent: "d/b", externalComponent: "app", externalLevel: 2, callWeight: 1 }],
    });
    expect(report.summary.layering.componentCount).toBe(3);
    expect(report.summary.stableDependencies.componentEdgeCount).toBe(3);
    expect(
      report.violations
        .filter((v) => v.detector === "layering" && v.kind === "knot")
        .map((v) => (v.kind === "knot" ? v.components : [])),
    ).toEqual([["d/a", "d/b"]]);
  });

  it("carries no domain block when the request names none", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(domainFixture()), {});

    expect(report.domain).toBeUndefined();
  });
});

/**
 * bd tea-rags-mcp-rpx0v (epic xb669.2): `norms: true` adds the dependency-
 * norms view — every file's primary-type role (derived from the type rows
 * the graph db reads), the project's own precedent ledgers per
 * (roleSrc, roleDst, locality), and a verdict for every precedent-less edge.
 * Four inheritance families: controllers call services, services call
 * repositories, presenters call services; two edges have no precedent.
 */
describe("ArchitectureReportOps#build — dependency norms (bd tea-rags-mcp-rpx0v)", () => {
  const FAMILIES: readonly [string, string, string, readonly string[]][] = [
    ["ui/list.ts", "UiListController", "controller", ["IViewController"]],
    ["ui/form.ts", "UiFormController", "controller", ["IViewController"]],
    ["ui/nav.ts", "UiNavController", "controller", ["IViewController"]],
    ["ui/modal.ts", "UiModalController", "controller", ["IViewController"]],
    ["logic/tasks.ts", "TasksService", "service", ["IService"]],
    ["logic/billing.ts", "BillingService", "service", ["IService"]],
    ["logic/reports.ts", "ReportsService", "service", ["IService"]],
    ["data/taskRepo.ts", "TaskRepository", "repository", ["IRepository"]],
    ["data/billRepo.ts", "BillRepository", "repository", ["IRepository"]],
    ["present/board.ts", "BoardPresenter", "presenter", ["IPresenter"]],
    ["present/kanban.ts", "KanbanPresenter", "presenter", ["IPresenter"]],
  ];

  function typeRows() {
    return FAMILIES.map(([relPath, shortName], i) => ({
      symbolId: `${relPath}#${shortName}`,
      relPath,
      shortName,
      symbolKind: "class" as const,
      ancestors: FAMILIES[i][3],
    }));
  }

  function normsGraph(): FileDependencyGraph {
    const files = FAMILIES.map(([relPath]) => file(relPath));
    const edges: FileDependencyGraph["edges"] = [];
    const add = (sourceRelPath: string, targetRelPath: string, callWeight = 1) => {
      edges.push({ sourceRelPath, targetRelPath, callWeight });
    };
    const ofRole = (role: string) => FAMILIES.filter(([, , r]) => r === role).map(([f]) => f);
    for (const c of ofRole("controller")) for (const s of ofRole("service")) add(c, s);
    for (const s of ofRole("service")) for (const r of ofRole("repository")) add(s, r);
    for (const p of ofRole("presenter")) for (const s of ofRole("service")) add(p, s);
    add("ui/list.ts", "data/taskRepo.ts", 2);
    add("logic/tasks.ts", "present/board.ts");
    return { files, edges };
  }

  it("judges every precedent-less edge when the request asks for norms", async () => {
    const report = await new ArchitectureReportOps().build(
      graphDb(normsGraph(), [], { meta: null, edges: [] }, typeRows()),
      {
        norms: true,
      },
    );

    expect(report.norms?.summary).toMatchObject({ typedEdgeCount: 26, judgedEdgeCount: 26, violationCount: 2 });
    expect(report.norms?.threshold.method).toBe("otsu");
    expect(report.norms?.findings).toEqual([
      expect.objectContaining({
        kind: "misfit",
        sourceRelPath: "ui/list.ts",
        targetRelPath: "data/taskRepo.ts",
        roleSrc: "controller",
        roleDst: "repository",
        expectedPath: { via: "service", support: 6 },
      }),
      expect.objectContaining({
        kind: "newPattern",
        sourceRelPath: "logic/tasks.ts",
        targetRelPath: "present/board.ts",
        roleSrc: "service",
        roleDst: "presenter",
      }),
    ]);
    expect(
      report.violations
        .filter((v) => v.detector === "norms")
        .map((v) => (v.detector === "norms" ? [v.kind, v.sourceRelPath, v.evidence.roleSrc] : [])),
    ).toEqual([
      ["misfit", "ui/list.ts", "controller"],
      ["newPattern", "logic/tasks.ts", "service"],
    ]);
  });

  it("carries no norms block and no norms violations when the request does not ask", async () => {
    const report = await new ArchitectureReportOps().build(
      graphDb(normsGraph(), [], { meta: null, edges: [] }, typeRows()),
      {},
    );

    expect(report.norms).toBeUndefined();
    expect(report.violations.some((v) => v.detector === "norms")).toBe(false);
  });

  // bd tea-rags-mcp-mv8yv: the request's pathPattern scopes the norms FINDINGS
  // by source, the way it scopes every other detector — dropped findings are
  // counted in the summary, not silently mixed into the scoped answer.
  it("scopes norms findings by the request's pathPattern and counts the dropped ones", async () => {
    const report = await new ArchitectureReportOps().build(
      graphDb(normsGraph(), [], { meta: null, edges: [] }, typeRows()),
      { norms: true, pathPattern: "ui/**" },
    );

    expect(report.norms?.summary).toMatchObject({ violationCount: 1, outOfScopeFindingCount: 1 });
    expect(report.norms?.findings.map((f) => f.sourceRelPath)).toEqual(["ui/list.ts"]);
    expect(report.violations.filter((v) => v.detector === "norms").map((v) => v.sourceRelPath)).toEqual(["ui/list.ts"]);
  });
});

// bd tea-rags-mcp-r8hme.9 — scripts, spikes, benchmarks, examples and fixtures
// are tooling, not architecture: every detector judges the graph without them.
describe("ArchitectureReportOps#build — non-production paths (bd tea-rags-mcp-r8hme.9)", () => {
  const NON_PRODUCTION =
    "non-production path: scripts, spikes, benchmarks, examples or fixtures - tooling, not architecture";

  function withSpike(): FileDependencyGraph {
    const g = graph();
    return {
      files: [...g.files, file("scripts/spikes/probe.ts")],
      edges: [...g.edges, { sourceRelPath: "scripts/spikes/probe.ts", targetRelPath: "core/b.ts", callWeight: 3 }],
    };
  }

  function underscoreCall(sourceRelPath: string): NonPublicMemberEdge {
    return {
      sourceRelPath,
      sourceSymbolId: "render",
      targetRelPath: "pkg/repo.py",
      targetSymbolId: "Repo#_load",
      targetShortName: "_load",
      targetVisibility: null,
      targetLanguage: "python",
      callExpression: "repo._load()",
    };
  }

  it("judges every detector on the production graph and counts what it left out", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(withSpike()), {});
    const baseline = await new ArchitectureReportOps().build(graphDb(graph()), {});

    expect(report.violations).toEqual(baseline.violations);
    expect(report.summary.stableDependencies.edgeCount).toBe(graph().edges.length);
    expect(report.summary.nonProduction).toEqual({
      excludedFileCount: 1,
      excludedEdgeCount: 1,
      reason: NON_PRODUCTION,
    });
  });

  it("drops a convention-privacy leak whose source is non-production", async () => {
    const edges = [underscoreCall("app/views.py"), underscoreCall("scripts/spikes/probe.py")];
    const report = await new ArchitectureReportOps().build(graphDb(facadeGraph(), edges), {});

    expect(report.summary.leakingAbstraction.violationsByKind.conventionPrivacy).toBe(1);
  });

  it("reports nothing excluded for a collection with no graph database", () => {
    expect(ArchitectureReportOps.empty({}).summary.nonProduction).toEqual({
      excludedFileCount: 0,
      excludedEdgeCount: 0,
      reason: NON_PRODUCTION,
    });
  });
});

// bd tea-rags-mcp-r8hme.8 — Stable Abstractions: per component, A from the
// walker's type census, I from the component graph, D = |A + I - 1|.
describe("ArchitectureReportOps#build — mainSequence (bd tea-rags-mcp-r8hme.8)", () => {
  const census = (abstractTypeCount: number, concreteTypeCount: number) => ({ abstractTypeCount, concreteTypeCount });

  /** `core/` stable and concrete, `ports/` unstable and abstract, `app/` on the sequence, `vendor/` typeless. */
  function censusGraph(): FileDependencyGraph {
    const files = [
      { ...file("core/a.ts"), typeAbstractness: census(0, 3) },
      { ...file("core/b.ts"), typeAbstractness: census(0, 3) },
      { ...file("vendor/v.ts"), typeAbstractness: census(0, 0) },
    ];
    const edges: FileDependencyGraph["edges"] = [];
    for (let i = 1; i <= 6; i++) {
      files.push({ ...file(`app/c${i}.ts`), typeAbstractness: census(0, 1) });
      edges.push({ sourceRelPath: `app/c${i}.ts`, targetRelPath: "core/b.ts", callWeight: 1 });
    }
    for (let i = 1; i <= 5; i++) {
      files.push({ ...file(`ports/p${i}.ts`), typeAbstractness: census(1, 0) });
      edges.push({ sourceRelPath: `ports/p${i}.ts`, targetRelPath: "vendor/v.ts", callWeight: 1 });
    }
    return { files, edges };
  }

  it("reports components off the main sequence after the other detectors, with their census and coupling", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(censusGraph()), {});

    expect(report.violations.filter((v) => v.detector === "mainSequence")).toEqual([
      {
        detector: "mainSequence",
        component: "core",
        componentKind: "directory",
        facadeRelPath: null,
        evidence: {
          zone: "pain",
          distance: 1,
          abstractness: 0,
          instability: 0,
          abstractTypeCount: 0,
          concreteTypeCount: 6,
          afferentCount: 6,
          efferentCount: 0,
          fileCount: 2,
          unmeasuredFileCount: 0,
        },
      },
      {
        detector: "mainSequence",
        component: "ports",
        componentKind: "directory",
        facadeRelPath: null,
        evidence: {
          zone: "uselessness",
          distance: 1,
          abstractness: 1,
          instability: 1,
          abstractTypeCount: 5,
          concreteTypeCount: 0,
          afferentCount: 0,
          efferentCount: 5,
          fileCount: 5,
          unmeasuredFileCount: 0,
        },
      },
    ]);
    expect(report.violations.at(-1)?.detector).toBe("mainSequence");
  });

  it("summarises the judged components, the adaptive cut and the exclusions", async () => {
    const summary = (await new ArchitectureReportOps().build(graphDb(censusGraph()), {})).summary.mainSequence;

    expect(summary).toMatchObject({
      judgedComponentCount: 3,
      violationCount: 2,
      painCount: 1,
      uselessnessCount: 1,
      meanDistance: 0.667,
      distanceThreshold: 0.5,
      distanceThresholdMethod: "majority",
      minConnectionCount: 5,
      minTypeCount: 5,
      abstractTypeShareByLanguage: { typescript: 0.294 },
      excluded: { lowConnectionCount: 0, unmeasured: 0, fewTypes: 1, unobservableAbstractness: 0 },
    });
    expect(summary.exclusionReasons.unobservableAbstractness).toMatch(/abstractions/);
  });

  it("says the census is missing rather than reporting a clean graph on an index written before it", async () => {
    const summary = (await new ArchitectureReportOps().build(graphDb(), {})).summary.mainSequence;

    expect(summary.judgedComponentCount).toBe(0);
    expect(summary.excluded.unmeasured).toBeGreaterThan(0);
  });

  it("reports an empty main-sequence summary on a collection with no graph", () => {
    const summary = ArchitectureReportOps.empty({}).summary.mainSequence;

    expect(summary.judgedComponentCount).toBe(0);
    expect(summary.violationCount).toBe(0);
  });

  // bd tea-rags-mcp-r8hme.14 — the zone of pain hurts only a component that
  // keeps changing: volatility = mean git.file.commitCount over its files.
  describe("volatility gate on the zone of pain (bd tea-rags-mcp-r8hme.14)", () => {
    /** Every file changed twice, `core/` files `coreCommits` times. */
    function commitCounts(coreCommits: number) {
      return vi.fn(
        async () =>
          new Map(censusGraph().files.map((f) => [f.relPath, f.relPath.startsWith("core/") ? coreCommits : 2])),
      );
    }

    it("keeps a volatile stable-concrete component in pain, with its volatility and the cut it cleared", async () => {
      const report = await new ArchitectureReportOps().build(graphDb(censusGraph()), {}, undefined, commitCounts(9));

      const pain = report.violations.find((v) => v.detector === "mainSequence" && v.component === "core");
      expect(pain?.evidence).toMatchObject({
        zone: "pain",
        volatility: { value: 9, measuredFileCount: 2, threshold: 2, label: "volatile" },
      });
      expect(report.summary.mainSequence).toMatchObject({
        painCount: 1,
        volatility: {
          signal: "git.file.commitCount",
          threshold: 2,
          thresholdMethod: "fileMedian",
          fileMedian: 2,
          measuredComponentCount: 3,
        },
        excluded: { stableConcreteCalm: 0 },
      });
    });

    it("drops a calm stable-concrete component from pain and counts it with a reason", async () => {
      const report = await new ArchitectureReportOps().build(graphDb(censusGraph()), {}, undefined, commitCounts(1));

      const components = report.violations.filter((v) => v.detector === "mainSequence").map((v) => v.component);
      expect(components).toEqual(["ports"]);
      const { mainSequence } = report.summary;
      expect(mainSequence).toMatchObject({ violationCount: 1, painCount: 0, excluded: { stableConcreteCalm: 1 } });
      expect(mainSequence.exclusionReasons.stableConcreteCalm).toMatch(/chang/);
    });

    it("reads no commit counts when nothing sits in the zone of pain", async () => {
      const g = censusGraph();
      g.files = g.files.filter((f) => !f.relPath.startsWith("core/"));
      g.edges = g.edges.filter((e) => !e.targetRelPath.startsWith("core/"));
      const read = commitCounts(9);

      const summary = (await new ArchitectureReportOps().build(graphDb(g), {}, undefined, read)).summary.mainSequence;

      expect(read).not.toHaveBeenCalled();
      expect(summary.volatility).toBeUndefined();
      expect(summary.excluded.stableConcreteCalm).toBe(0);
    });

    it("says the volatility gate did not run when there is no reader", async () => {
      const summary = (await new ArchitectureReportOps().build(graphDb(censusGraph()), {})).summary.mainSequence;

      expect(summary.painCount).toBe(1);
      expect(summary.volatility).toBeUndefined();
      expect(summary.excluded.stableConcreteCalm).toBe(0);
    });
  });
});

/**
 * Layering evidence cap (bd tea-rags-mcp-r8hme.37): a taxdome knot of 4628
 * components with a 14437-edge feedback arc set made one finding 9.5 MB. The
 * public DTO lists the first members / cut edges and carries the totals.
 *
 * Ring of 30 directory components, one file each, with both directions of
 * every neighbour pair (c_i ⇄ c_{i+1 mod 30}), all weights equal: one knot,
 * every member at Ca 2 (so path order), and 30 edge-disjoint 2-cycles — no cut
 * of fewer than 30 edges dissolves it.
 */
function bidirectionalRing(size = 30): FileDependencyGraph {
  const dir = (i: number) => `c${String(i % size).padStart(2, "0")}`;
  const files = Array.from({ length: size }, (_, i) => file(`${dir(i)}/m.ts`));
  const edges: FileDependencyGraph["edges"] = [];
  for (let i = 0; i < size; i++) {
    edges.push({ sourceRelPath: `${dir(i)}/m.ts`, targetRelPath: `${dir(i + 1)}/m.ts`, callWeight: 1 });
    edges.push({ sourceRelPath: `${dir(i + 1)}/m.ts`, targetRelPath: `${dir(i)}/m.ts`, callWeight: 1 });
  }
  return { files, edges };
}

/** `parent/` ⇄ each of 12 nested `parent/nNN/` directories: one composition cycle, 12 nested pairs. */
function wideComposition(nestedCount = 12): FileDependencyGraph {
  const files = [file("parent/p.ts")];
  const edges: FileDependencyGraph["edges"] = [];
  for (let i = 0; i < nestedCount; i++) {
    const nested = `parent/n${String(i).padStart(2, "0")}/x.ts`;
    files.push(file(nested));
    edges.push({ sourceRelPath: "parent/p.ts", targetRelPath: nested, callWeight: 1 });
    edges.push({ sourceRelPath: nested, targetRelPath: "parent/p.ts", callWeight: 1 });
  }
  return { files, edges };
}

describe("ArchitectureReportOps#build — layering evidence cap (bd tea-rags-mcp-r8hme.37)", () => {
  const findKnot = (report: Awaited<ReturnType<ArchitectureReportOps["build"]>>) => {
    const knot = report.violations.find((v) => v.detector === "layering" && v.kind === "knot");
    if (knot?.detector !== "layering" || knot.kind !== "knot") throw new Error("no knot finding");
    return knot;
  };

  it("lists the first 20 knot members and 10 cut edges while carrying the member and cut totals", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(bidirectionalRing()), { limit: 500 });

    const knot = findKnot(report);
    expect(knot.components).toEqual(Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(2, "0")}`));
    expect(knot.evidence.memberCount).toBe(30);
    expect(knot.evidence.feedbackArcSet).toHaveLength(10);
    expect(knot.evidence.cutEdgeCount).toBeGreaterThanOrEqual(30);
  });

  it("counts only the in-scope members when scoped, the rest riding in outOfScopeMemberCount", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(bidirectionalRing()), {
      limit: 500,
      pathPattern: "{c00,c01,c02}/**",
    });

    const knot = findKnot(report);
    expect(knot.components).toEqual(["c00", "c01", "c02"]);
    expect(knot.evidence.memberCount).toBe(3);
    expect(knot.evidence.outOfScopeMemberCount).toBe(27);
  });

  it("lists the first 10 nested pairs of a composition cycle with the member and pair totals", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(wideComposition()), { limit: 500 });

    const cycle = report.violations.find((v) => v.detector === "layering" && v.kind === "compositionCycle");
    if (cycle?.detector !== "layering" || cycle.kind !== "compositionCycle") throw new Error("no composition cycle");
    expect(cycle.components).toHaveLength(13);
    expect(cycle.evidence.memberCount).toBe(13);
    expect(cycle.evidence.nestedPairs).toHaveLength(10);
    expect(cycle.evidence.nestedPairCount).toBe(12);
  });
});

describe("ArchitectureReportOps#build — knotOf view and drillDown (bd tea-rags-mcp-r8hme.38)", () => {
  const ring = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => `c${String(from + i).padStart(2, "0")}`);

  it("points every knot finding at its top member by Ca, before the member cap", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(bidirectionalRing()), {});

    const knot = report.violations.find((v) => v.detector === "layering" && v.kind === "knot");
    if (knot?.detector !== "layering" || knot.kind !== "knot") throw new Error("no knot finding");
    // Every member sits at Ca 2, so path order: c00 leads. The ring spans c00..c29 — no common subtree.
    expect(knot.evidence.drillDown).toEqual({
      knotOf: "c00",
      hint: "call get_architecture_report with knotOf to page every member and cut edge of this knot",
    });
  });

  it("returns no knot view unless the request names a component", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(bidirectionalRing()), {});

    expect(report).not.toHaveProperty("knot");
  });

  it("pages the members by Ca and the cut by weight, pointing at the next page", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(bidirectionalRing()), { knotOf: "c07", limit: 10 });

    expect(report.knot).toMatchObject({ component: "c07", inKnot: true, offset: 0, limit: 10 });
    expect(report.knot?.knot?.members.map((m) => m.component)).toEqual(ring(0, 10));
    expect(report.knot?.knot?.feedbackArcSet).toHaveLength(10);
    expect(report.knot?.knot).toMatchObject({
      memberCount: 30,
      cutEdgeCount: 30,
      composition: false,
      nextOffset: 10,
    });
  });

  it("returns the last page without a next offset", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(bidirectionalRing()), {
      knotOf: "c07",
      limit: 10,
      offset: 20,
    });

    expect(report.knot?.offset).toBe(20);
    expect(report.knot?.knot?.members.map((m) => m.component)).toEqual(ring(20, 30));
    expect(report.knot?.knot?.feedbackArcSet).toHaveLength(10);
    expect(report.knot?.knot).not.toHaveProperty("nextOffset");
  });

  it("projects the view onto pathPattern before paging it", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(bidirectionalRing()), {
      knotOf: "c07",
      limit: 10,
      pathPattern: "{c00,c01,c02}/**",
    });

    expect(report.knot?.knot?.members.map((m) => m.component)).toEqual(["c00", "c01", "c02"]);
    expect(report.knot?.knot).toMatchObject({ memberCount: 3, outOfScopeMemberCount: 27, cutEdgeCount: 30 });
    expect(report.knot?.knot).not.toHaveProperty("nextOffset");
  });

  it("gives a component outside every knot its level and depth, and no knot", async () => {
    // graph(): vendor is the foundation every lib file depends on.
    const report = await new ArchitectureReportOps().build(graphDb(), { knotOf: "vendor" });

    expect(report.knot).toEqual({ component: "vendor", inKnot: false, level: 0, depth: 3, offset: 0, limit: 50 });
  });

  it("lists the knot's back-edges in the view", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), { knotOf: "lib" });

    expect(report.knot?.knot?.members.map((m) => m.component)).toEqual(["core", "lib"]);
    expect(report.knot?.knot?.backEdges).toEqual([
      {
        detector: "layering",
        kind: "backEdge",
        sourceComponent: "lib",
        targetComponent: "core",
        evidence: {
          callWeight: 1,
          counterFlowWeight: 3,
          fileEdgeCount: 1,
          fileEdges: [{ sourceRelPath: "lib/f5.ts", targetRelPath: "core/a.ts", callWeight: 1 }],
        },
      },
    ]);
  });

  it("returns a composition cycle's member with the composition flag", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(wideComposition()), { knotOf: "parent/n03" });

    expect(report.knot?.knot).toMatchObject({ memberCount: 13, composition: true, backEdges: [] });
  });

  it("rejects a component the graph does not hold with a typed input error", async () => {
    await expect(
      new ArchitectureReportOps().build(graphDb(bidirectionalRing()), { knotOf: "nowhere" }),
    ).rejects.toBeInstanceOf(UnknownArchitectureComponentError);
  });
});

/**
 * Keep cost per cut edge on the knotOf page (bd tea-rags-mcp-r8hme.40). On the
 * bidirectional ring every weight is equal, so the canonical greedy sequence
 * (bd tea-rags-mcp-r8hme.42) is c29, c28, …, c00 and the cut is the 29 ring
 * edges c_i→c_{i+1} plus the wrap c00→c29; what remains is the chain
 * c29→c28→…→c00 and c01→c00. Keeping c_i→c_{i+1} re-collapses exactly
 * c_i⇄c_{i+1} (c_i reaches c_{i+1} only directly), 30 members on 29 levels.
 * Keeping c00→c29 closes the whole chain: all 30 members, one level.
 */
describe("ArchitectureReportOps#build — knotOf keep cost per cut edge (bd tea-rags-mcp-r8hme.40)", () => {
  const pairs = (edges: readonly { sourceComponent: string; targetComponent: string }[] | undefined) =>
    (edges ?? []).map((edge) => `${edge.sourceComponent}->${edge.targetComponent}`);

  it("prices every cut edge on the page by the members it re-collapses and the levels they keep", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(bidirectionalRing()), { knotOf: "c07", limit: 10 });

    const page = report.knot?.knot?.feedbackArcSet ?? [];
    // Canonical ELS (bd tea-rags-mcp-r8hme.42): the cut takes the ring
    // direction c_i -> c_{i+1} plus the wrap c00 -> c29, one edge per
    // adjacent pair, sorted by source.
    expect(pairs(page)).toEqual([
      "c00->c01",
      "c00->c29",
      "c01->c02",
      "c02->c03",
      "c03->c04",
      "c04->c05",
      "c05->c06",
      "c06->c07",
      "c07->c08",
      "c08->c09",
    ]);
    for (const edge of page) {
      // The wrap edge re-collapses the whole ring; every ring step only its own pair.
      const expected =
        edge.sourceComponent === "c00" && edge.targetComponent === "c29"
          ? { recollapsedMemberCount: 30, levelsAfterKeep: 1 }
          : { recollapsedMemberCount: 2, levelsAfterKeep: 29 };
      expect(edge.keepCost).toEqual(expected);
    }
  });

  it("prices the edge that closes the whole ring as re-collapsing every member", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(bidirectionalRing()), { knotOf: "c07", limit: 10 });

    // The wrap edge sorts by source right beside c00 -> c01.
    const closing = report.knot?.knot?.feedbackArcSet.find(
      (edge) => edge.sourceComponent === "c00" && edge.targetComponent === "c29",
    );
    expect(closing?.keepCost).toEqual({ recollapsedMemberCount: 30, levelsAfterKeep: 1 });
  });

  it("prices the projected page's edges on the WHOLE knot under pathPattern", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(bidirectionalRing()), {
      knotOf: "c07",
      limit: 10,
      pathPattern: "{c00,c01,c02}/**",
    });

    const page = report.knot?.knot?.feedbackArcSet ?? [];
    // c00, c01 and c02 own the files carrying four cut edges: the two ring
    // steps out of c00 and c01, and the wrap c00 -> c29.
    expect(pairs(page)).toEqual(["c00->c01", "c00->c29", "c01->c02", "c02->c03"]);
    const costOf = (pair: string) =>
      page.find((edge) => `${edge.sourceComponent}->${edge.targetComponent}` === pair)?.keepCost;
    // 29 levels is a 30-member reading — the 3 in-scope members alone could span at most 3.
    expect(costOf("c00->c01")).toEqual({ recollapsedMemberCount: 2, levelsAfterKeep: 29 });
    expect(costOf("c00->c29")).toEqual({ recollapsedMemberCount: 30, levelsAfterKeep: 1 });
    expect(costOf("c01->c02")).toEqual({ recollapsedMemberCount: 2, levelsAfterKeep: 29 });
    expect(costOf("c02->c03")).toEqual({ recollapsedMemberCount: 2, levelsAfterKeep: 29 });
  });

  it("leaves the report's knot findings without a keep cost", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(bidirectionalRing()), {});

    const knot = report.violations.find((v) => v.detector === "layering" && v.kind === "knot");
    if (knot?.detector !== "layering" || knot.kind !== "knot") throw new Error("no knot finding");
    expect(knot.evidence.feedbackArcSet.length).toBeGreaterThan(0);
    for (const edge of knot.evidence.feedbackArcSet) expect(edge).not.toHaveProperty("keepCost");
  });
});

/**
 * knotOf mode (bd tea-rags-mcp-r8hme.39): a knotOf call answers for the knot
 * — its members with their coupling, and what the other detectors found
 * INSIDE it — instead of resending the whole-project report every page.
 */
describe("ArchitectureReportOps#build — knotOf mode scopes the findings to the knot (bd tea-rags-mcp-r8hme.39)", () => {
  it("lists only the findings with both ends in the knot on the first page, and no layering finding", async () => {
    // graph(): core ⇄ lib is the knot; base → lib runs uphill from outside it, core → lib inside it.
    const whole = await new ArchitectureReportOps().build(graphDb(), {});
    expect(whole.violations.filter((v) => v.detector === "stableDependencies")).toHaveLength(2);

    const report = await new ArchitectureReportOps().build(graphDb(), { knotOf: "lib" });

    expect(report.violations).toEqual([
      expect.objectContaining({ detector: "stableDependencies", sourceComponent: "core", targetComponent: "lib" }),
    ]);
    expect(report.rootCauses).toEqual([
      expect.objectContaining({ detector: "stableDependencies", targetComponent: "lib" }),
    ]);
  });

  it("carries only the view on a later page", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), { knotOf: "lib", limit: 1, offset: 1 });

    expect(report.violations).toEqual([]);
    expect(report.rootCauses).toEqual([]);
    expect(report.knot?.knot?.members.map((m) => m.component)).toEqual(["lib"]);
  });

  it("gives every member its instability, Ca and Ce, and the view the knot's instability spread", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), { knotOf: "lib" });

    expect(report.knot?.knot?.members).toEqual([
      { component: "core", instability: 0.222, afferentCount: 7, efferentCount: 2 },
      { component: "lib", instability: 0.556, afferentCount: 4, efferentCount: 5 },
    ]);
    expect(report.knot?.knot?.instabilitySpread).toBe(0.333);
  });

  it("lists the projected members under pathPattern, with their stats", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(bidirectionalRing()), {
      knotOf: "c07",
      pathPattern: "{c00,c01,c02}/**",
    });

    // Ring member: two neighbours' files import it, its one file imports both → Ca 2, Ce 1.
    expect(report.knot?.knot?.members).toEqual(
      ["c00", "c01", "c02"].map((component) => ({ component, instability: 0.333, afferentCount: 2, efferentCount: 1 })),
    );
  });

  it("keeps a silent-coupling pair whose files both sit in knot members and drops one reaching outside", async () => {
    // silentCouplingGraph(): app ⇄ lib is the knot (s1 → hub, hub → s1); web sits outside it.
    const cochange = cochangeGraph();
    const outside = { ...cochange.edges[0], relPathA: "app/private.ts", relPathB: "web/s2.ts" };
    const withOutside = { ...cochange, edges: [...cochange.edges, outside] };
    const pairs = (violations: Awaited<ReturnType<ArchitectureReportOps["build"]>>["violations"]) =>
      violations.flatMap((v) => (v.detector === "silentCoupling" ? [[v.sourceRelPath, v.targetRelPath]] : []));

    const whole = await new ArchitectureReportOps().build(graphDb(silentCouplingGraph(), [], withOutside), {});
    expect(pairs(whole.violations)).toContainEqual(["app/private.ts", "web/s2.ts"]);

    const report = await new ArchitectureReportOps().build(graphDb(silentCouplingGraph(), [], withOutside), {
      knotOf: "lib",
    });
    expect(report.knot?.knot?.members.map((m) => m.component).sort()).toEqual(["app", "lib"]);
    expect(pairs(report.violations)).toEqual([["app/s1.ts", "lib/hub.ts"]]);
  });

  it("places an adoption-partition directory under an unadopted facade inside the knot through its files", () => {
    const partition = (componentOf: Record<string, string>) => ({
      components: new Map(),
      componentOf: new Map(Object.entries(componentOf)),
      dependencies: [],
      excluded: { selfEdges: 0, unwalkedEndpoints: 0, intraComponent: 0, facadeAggregations: 0 },
      fileEdgeCount: 0,
    });
    // Domain partition: lang/ owns its subtree. Adoption partition: nobody
    // adopted lang/index.ts, so lang/strategies/ stands as its own directory.
    const domain = partition({ "lang/index.ts": "lang", "lang/strategies/s.ts": "lang", "kernel/k.ts": "kernel" });
    const adoption = partition({
      "lang/index.ts": "lang",
      "lang/strategies/s.ts": "lang/strategies",
      "kernel/k.ts": "kernel",
    });

    const membership = buildArchitectureKnotMembership(["lang"], domain, adoption);

    expect(membership.holdsComponent("lang")).toBe(true);
    expect(membership.holdsComponent("lang/strategies")).toBe(true);
    expect(membership.holdsComponent("kernel")).toBe(false);
    expect(membership.holdsFile("lang/strategies/s.ts")).toBe(true);
    expect(membership.holdsFile("kernel/k.ts")).toBe(false);
    // A file the walk never extracted belongs to no member.
    expect(membership.holdsFile("assets/style.css")).toBe(false);
  });

  it("keeps the summary whole-project", async () => {
    const whole = await new ArchitectureReportOps().build(graphDb(), {});
    const report = await new ArchitectureReportOps().build(graphDb(), { knotOf: "lib" });

    expect(report.summary).toEqual(whole.summary);
  });
});
