/**
 * ArchitectureGraphFacts (bd tea-rags-mcp-89k7k.35.4) — the one immutable
 * snapshot of every graph-DB read the architecture report judges, so the
 * detector run is pure over it, and `applyEdgeOverlay` — the base-vs-overlay
 * substrate 89k7k.1.7 runs the full detector set twice over.
 */
import { describe, expect, it, vi } from "vitest";

import { readArchitectureGraphFacts } from "../../../../../src/core/api/internal/ops/architecture-graph-facts.js";
import { ArchitectureReportOps } from "../../../../../src/core/api/internal/ops/architecture-report-ops.js";
import type {
  FileDependencyGraph,
  NonPublicMemberEdge,
  TemporalCochangeGraph,
} from "../../../../../src/core/contracts/types/codegraph.js";
import {
  applyEdgeOverlay,
  ARCHITECTURE_FACTS_NOT_REFRESHED_BY_EDGE_OVERLAY,
  ReviewEdgeOverlay,
} from "../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

/** The same component fixture `architecture-report-ops.test.ts` judges: core/base stable, lib unstable, other a leaf. */
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
  const cochange: TemporalCochangeGraph = { meta: null, edges: [] };
  return {
    readFileDependencyGraph: vi.fn().mockResolvedValue(g),
    readNonPublicMemberEdges: vi.fn().mockResolvedValue(nonPublicEdges),
    readTemporalCochangeGraph: vi.fn().mockResolvedValue(cochange),
    readTypeNameRows: vi.fn().mockResolvedValue([]),
  };
}

describe("readArchitectureGraphFacts", () => {
  it("reads the type rows only when norms are asked", async () => {
    const db = graphDb();
    const facts = await readArchitectureGraphFacts(db, {});
    expect(db.readTypeNameRows).not.toHaveBeenCalled();
    expect(facts.typeNameRows).toBeUndefined();

    await readArchitectureGraphFacts(db, { norms: true });
    expect(db.readTypeNameRows).toHaveBeenCalledTimes(1);
  });

  it("reads the class hierarchy only when a Python member edge needs the subclass exemption", async () => {
    const pythonEdge = { targetLanguage: "python" } as NonPublicMemberEdge;
    const loadHierarchySnapshot = vi.fn().mockResolvedValue({ parents: new Map() });
    const without = await readArchitectureGraphFacts({ ...graphDb(), loadHierarchySnapshot }, {});
    expect(loadHierarchySnapshot).not.toHaveBeenCalled();
    expect(without.classHierarchy).toBeUndefined();

    const withPython = await readArchitectureGraphFacts(
      { ...graphDb(graph(), [pythonEdge]), loadHierarchySnapshot },
      {},
    );
    expect(loadHierarchySnapshot).toHaveBeenCalledTimes(1);
    expect(withPython.classHierarchy).toEqual({ parents: new Map() });
  });
});

describe("ArchitectureReportOps#judge", () => {
  it("judges a facts snapshot exactly as build judges the graph DB it was read from", async () => {
    const ops = new ArchitectureReportOps();
    const facts = await readArchitectureGraphFacts(graphDb(), {});

    expect(await ops.judge(facts, {})).toEqual(await ops.build(graphDb(), {}));
  });

  it("runs the full detector set on base and overlaid facts and sees the island an added edge resolves", async () => {
    const ops = new ArchitectureReportOps();
    const base = await readArchitectureGraphFacts(graphDb(), {});
    // core/b.ts keeps its import of lib and ADDS one of the leaf `other/`.
    const overlay = new ReviewEdgeOverlay([
      {
        relPath: "core/b.ts",
        language: "typescript",
        edges: [
          { sourceRelPath: "core/b.ts", targetRelPath: "lib/f2.ts" },
          { sourceRelPath: "core/b.ts", targetRelPath: "other/o.ts" },
        ],
      },
    ]);

    const before = await ops.judge(base, {});
    const after = await ops.judge(applyEdgeOverlay(base, overlay), {});

    expect(after.violations).not.toEqual(before.violations);
    // `other/` gains its first importer, so it is no longer a layering island.
    const otherIsland = expect.objectContaining({ detector: "layering", kind: "island", component: "other" });
    expect(before.violations).toContainEqual(otherIsland);
    expect(after.violations).not.toContainEqual(otherIsland);
  });
});

describe("applyEdgeOverlay", () => {
  it("replaces an overlaid file's out-edges, keeps every other file's, and leaves the base untouched", async () => {
    const base = await readArchitectureGraphFacts(graphDb(), {});
    const baseEdges = [...base.production.graph.edges];
    const overlay = new ReviewEdgeOverlay([
      {
        relPath: "core/a.ts",
        language: "typescript",
        edges: [{ sourceRelPath: "core/a.ts", targetRelPath: "vendor/v.ts", importedExportNames: ["v"] }],
      },
    ]);

    const overlaid = applyEdgeOverlay(base, overlay);

    const fromCoreA = overlaid.production.graph.edges.filter((e) => e.sourceRelPath === "core/a.ts");
    expect(fromCoreA).toEqual([
      { sourceRelPath: "core/a.ts", targetRelPath: "vendor/v.ts", callWeight: 0, importedExportNames: ["v"] },
    ]);
    expect(overlaid.production.graph.edges.filter((e) => e.sourceRelPath !== "core/a.ts")).toEqual(
      baseEdges.filter((e) => e.sourceRelPath !== "core/a.ts"),
    );
    expect(base.production.graph.edges).toEqual(baseEdges);
    expect(overlaid.edgeOverlay?.refreshedFiles).toEqual(new Set(["core/a.ts"]));
  });

  it("carries the indexed call weight and import text of a pair the index already held", async () => {
    const base = await readArchitectureGraphFacts(graphDb(), {});
    const overlay = new ReviewEdgeOverlay([
      { relPath: "core/a.ts", edges: [{ sourceRelPath: "core/a.ts", targetRelPath: "lib/f1.ts" }] },
    ]);

    const [edge] = applyEdgeOverlay(base, overlay).production.graph.edges.filter(
      (e) => e.sourceRelPath === "core/a.ts",
    );

    expect(edge).toEqual({ sourceRelPath: "core/a.ts", targetRelPath: "lib/f1.ts", callWeight: 2 });
  });

  it("keeps an unsupported file's indexed edges but lists it notJudged, never as silently refreshed", async () => {
    const base = await readArchitectureGraphFacts(graphDb(), {});
    const overlay = new ReviewEdgeOverlay([
      { relPath: "core/a.ts", language: "ruby", edges: [], skip: { reason: "unsupportedLanguage" } },
    ]);

    const overlaid = applyEdgeOverlay(base, overlay);

    expect(overlaid.production.graph.edges).toEqual(base.production.graph.edges);
    expect(overlaid.edgeOverlay?.refreshedFiles).toEqual(new Set());
    expect(overlaid.edgeOverlay?.notJudgedFiles).toEqual([{ relPath: "core/a.ts", reason: "unsupportedLanguage" }]);
  });

  it("drops an overlay edge with a non-production endpoint, as the production read does", async () => {
    const base = await readArchitectureGraphFacts(graphDb(), {});
    const overlay = new ReviewEdgeOverlay([
      {
        relPath: "core/a.ts",
        edges: [{ sourceRelPath: "core/a.ts", targetRelPath: "scripts/tool.ts" }],
      },
    ]);

    const overlaid = applyEdgeOverlay(base, overlay);

    expect(overlaid.production.graph.edges.filter((e) => e.sourceRelPath === "core/a.ts")).toEqual([]);
  });

  it("declares the facts an edge overlay cannot refresh, member edges and hierarchy among them", async () => {
    const base = await readArchitectureGraphFacts(graphDb(), {});
    const overlaid = applyEdgeOverlay(base, new ReviewEdgeOverlay([]));

    expect(ARCHITECTURE_FACTS_NOT_REFRESHED_BY_EDGE_OVERLAY).toEqual(
      expect.arrayContaining(["memberEdges", "classHierarchy"]),
    );
    expect(overlaid.edgeOverlay?.notRefreshed).toBe(ARCHITECTURE_FACTS_NOT_REFRESHED_BY_EDGE_OVERLAY);
    expect(overlaid.memberEdges).toBe(base.memberEdges);
    expect(overlaid.cochange).toBe(base.cochange);
  });
});

describe("applyEdgeOverlay — abstractionBypass evidence parity (bd tea-rags-mcp-r8hme.52.6)", () => {
  /**
   * `app` imports `Panel` from the concrete `ulanzi`; `Panel` implements
   * `device`'s `Device`, and `app` never touches `device` — one evidenced bypass.
   */
  function bypassGraph(): FileDependencyGraph {
    const census = (abstractTypeCount: number, concreteTypeCount: number) => ({
      abstractTypeCount,
      concreteTypeCount,
    });
    return {
      files: [
        { ...file("device/d.ts"), typeAbstractness: census(6, 0) },
        {
          ...file("ulanzi/u1.ts"),
          typeAbstractness: census(0, 6),
          typeHeritage: [{ typeName: "Panel", supertypes: [{ name: "Device", declaringRelPaths: ["device/d.ts"] }] }],
        },
        { ...file("app/s.ts"), typeAbstractness: census(0, 6) },
      ],
      edges: [
        { sourceRelPath: "ulanzi/u1.ts", targetRelPath: "device/d.ts", callWeight: 1 },
        { sourceRelPath: "app/s.ts", targetRelPath: "ulanzi/u1.ts", callWeight: 1, importedExportNames: ["Panel"] },
      ],
    };
  }

  const bypass = expect.objectContaining({
    detector: "layering",
    kind: "abstractionBypass",
    sourceComponent: "app",
    targetComponent: "ulanzi",
  });

  it("reports the bypass with its implementedBy witness, and keeps the file heritage under an overlay", async () => {
    const ops = new ArchitectureReportOps();
    const base = await readArchitectureGraphFacts(graphDb(bypassGraph()), {});
    const overlaid = applyEdgeOverlay(base, new ReviewEdgeOverlay([]));

    expect(overlaid.production.graph.files).toBe(base.production.graph.files);
    const before = await ops.judge(base, {});
    expect(before.violations).toContainEqual(
      expect.objectContaining({
        kind: "abstractionBypass",
        evidence: expect.objectContaining({
          bypassedComponent: "device",
          implementedBy: {
            consumerRelPath: "app/s.ts",
            implementerTypeName: "Panel",
            implementerRelPath: "ulanzi/u1.ts",
            abstractionTypeName: "Device",
            abstractionRelPath: "device/d.ts",
          },
        }),
      }),
    );
    expect((await ops.judge(overlaid, {})).violations).toEqual(before.violations);
  });

  it("drops the bypass when the overlaid consumer stops importing the implementer", async () => {
    const ops = new ArchitectureReportOps();
    const base = await readArchitectureGraphFacts(graphDb(bypassGraph()), {});
    const overlay = new ReviewEdgeOverlay([
      {
        relPath: "app/s.ts",
        language: "typescript",
        edges: [{ sourceRelPath: "app/s.ts", targetRelPath: "ulanzi/u1.ts", importedExportNames: ["Helper"] }],
      },
    ]);

    expect((await ops.judge(base, {})).violations).toContainEqual(bypass);
    expect((await ops.judge(applyEdgeOverlay(base, overlay), {})).violations).not.toContainEqual(bypass);
  });
});
