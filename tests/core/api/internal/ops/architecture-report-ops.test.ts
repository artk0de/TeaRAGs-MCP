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
 * `lib/hub.ts` is imported by `app/s1.ts` and `web/s2.ts` (each with 5
 * importers of its own) and imports `app/s1.ts` back plus 4 leaves:
 * I(hub) = 5/7, I(s1) = 2/8, I(s2) = 1/6 — both sources violate SDP, and the
 * hub references one of its own dependents. `app/s1.ts` also imports
 * `app/private.ts`, which nothing else imports: a private collaborator.
 */
function graph(): FileDependencyGraph {
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

function graphDb(g: FileDependencyGraph = graph(), nonPublicEdges: NonPublicMemberEdge[] = []) {
  return {
    readFileDependencyGraph: vi.fn().mockResolvedValue(g),
    readNonPublicMemberEdges: vi.fn().mockResolvedValue(nonPublicEdges),
  };
}

describe("ArchitectureReportOps#build", () => {
  it("returns SDP violations with per-line evidence, most severe first", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), {});

    expect(report.violations).toEqual([
      {
        detector: "stableDependencies",
        sourceRelPath: "web/s2.ts",
        targetRelPath: "lib/hub.ts",
        evidence: {
          sourceInstability: 1 / 6,
          targetInstability: 5 / 7,
          instabilityDelta: 5 / 7 - 1 / 6,
          sourceConnectionCount: 6,
          targetConnectionCount: 7,
          callWeight: 2,
          directoryRelation: "disjoint",
        },
      },
      {
        detector: "stableDependencies",
        sourceRelPath: "app/s1.ts",
        targetRelPath: "lib/hub.ts",
        evidence: {
          sourceInstability: 2 / 8,
          targetInstability: 5 / 7,
          instabilityDelta: 5 / 7 - 2 / 8,
          sourceConnectionCount: 8,
          targetConnectionCount: 7,
          callWeight: 2,
          directoryRelation: "disjoint",
        },
      },
    ]);
  });

  it("returns root causes grouped by unstable target, flagging a cycle with its dependents", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), {});

    expect(report.rootCauses).toEqual([
      {
        detector: "stableDependencies",
        targetRelPath: "lib/hub.ts",
        targetInstability: 5 / 7,
        violationCount: 2,
        maxInstabilityDelta: 5 / 7 - 1 / 6,
        sources: ["app/s1.ts", "web/s2.ts"],
        cycleWithDependents: true,
      },
    ]);
  });

  it("summarises what was read, judged and excluded, naming each exclusion reason", async () => {
    const g = graph();
    const report = await new ArchitectureReportOps().build(graphDb(g), {});

    expect(report.summary.stableDependencies).toEqual({
      tolerance: 0.2,
      minConnectionCount: 5,
      edgeCount: g.edges.length,
      judgedEdgeCount: 3,
      violationCount: 2,
      rootCauseCount: 1,
      excluded: {
        selfEdges: 0,
        unwalkedEndpoints: 0,
        noSymbolEndpoints: 0,
        // INVARIANT CHANGED (bd tea-rags-mcp-r8hme.6): the exclusion summary gains facadeAggregations.
        facadeAggregations: 0,
        lowConnectionCount: g.edges.length - 3 - 1,
        privateCollaborators: 1,
      },
      exclusionReasons: {
        noSymbolEndpoints: "no-symbol endpoint: barrel, type-only or object-literal module",
        facadeAggregations: "facade aggregation: a module facade re-exporting a descendant module's facade",
        privateCollaborators: "private collaborator: source is the target's sole importer",
      },
    });
    expect(report.pathPattern).toBeUndefined();
  });

  it("scopes the judged edges to sources matching pathPattern and reports what fell outside", async () => {
    const g = graph();
    const report = await new ArchitectureReportOps().build(graphDb(g), { pathPattern: "app/**" });

    expect(report.pathPattern).toBe("app/**");
    expect(report.violations.map((v) => v.sourceRelPath)).toEqual(["app/s1.ts"]);
    expect(report.rootCauses.map((r) => r.sources)).toEqual([["app/s1.ts"]]);
    const outOfScope = g.edges.filter((e) => !e.sourceRelPath.startsWith("app/")).length;
    expect(report.summary.stableDependencies.outOfScopeEdgeCount).toBe(outOfScope);
  });

  it("caps violations and root causes at limit while the summary keeps the totals", async () => {
    const report = await new ArchitectureReportOps().build(graphDb(), { limit: 1 });

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].sourceRelPath).toBe("web/s2.ts");
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
      edges: [...g.edges, { sourceRelPath: "scripts/spikes/probe.ts", targetRelPath: "lib/hub.ts", callWeight: 3 }],
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
