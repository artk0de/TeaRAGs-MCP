/**
 * ArchitectureReportOps (bd tea-rags-mcp-94hd9) — the query behind
 * `get_architecture_report`: reads the file dependency graph from a codegraph
 * handle, runs the Stable Dependencies detector, and shapes the typed report.
 */
import { describe, expect, it, vi } from "vitest";

import { ArchitectureReportOps } from "../../../../../src/core/api/internal/ops/architecture-report-ops.js";
import type { FileDependencyGraph, NonPublicMemberEdge } from "../../../../../src/core/contracts/types/codegraph.js";

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

function graphDb(g: FileDependencyGraph = graph(), nonPublicEdges: NonPublicMemberEdge[] = []) {
  return {
    readFileDependencyGraph: vi.fn().mockResolvedValue(g),
    readNonPublicMemberEdges: vi.fn().mockResolvedValue(nonPublicEdges),
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
      report.violations.map((v) => (v.detector === "stableDependencies" ? v.sourceComponent : v.sourceRelPath)),
    ).toEqual(["base"]);
    expect(report.summary.stableDependencies.outOfScopeEdgeCount).toBe(6);
  });

  it("caps violations and root causes at limit while the summary keeps the totals", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), { limit: 1 });

    expect(report.violations).toHaveLength(1);
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
    const report = await new ArchitectureReportOps().build(graphDb(facadeGraph()), {});
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
        evidence: { ...evidence, callWeight: 1 },
      },
      {
        detector: "leakingAbstraction",
        kind: "bypass",
        sourceRelPath: "ext/e.ts",
        targetRelPath: "mod/shown.ts",
        evidence: { ...evidence, callWeight: 0 },
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

describe("ArchitectureReportOps.empty", () => {
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
