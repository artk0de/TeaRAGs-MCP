/**
 * Stable Dependencies Principle at COMPONENT level (bd tea-rags-mcp-r8hme.7):
 * I(source) ≥ I(target) judged on component dependencies, with a support
 * floor on each component's connection count; file edges ride along as the
 * evidence of which files carry the dependency.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildComponentGraph,
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  DEFAULT_SDP_TOLERANCE,
  detectComponentStableDependencyViolations,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function edge(
  sourceRelPath: string,
  targetRelPath: string,
  callWeight = 1,
  exportNames?: { importedExportNames?: string[]; reexportedExportNames?: string[] },
): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight, ...exportNames };
}

/** `count` files `${dir}/f{i}.ts`, each with an edge built by `link`. */
function files(dir: string, count: number, link: (relPath: string) => FileDependencyEdge) {
  const out: FileDependencyGraph = { files: [], edges: [] };
  for (let i = 1; i <= count; i++) {
    const relPath = `${dir}/f${i}.ts`;
    out.files.push(file(relPath));
    out.edges.push(link(relPath));
  }
  return out;
}

function merge(...parts: FileDependencyGraph[]): FileDependencyGraph {
  return { files: parts.flatMap((p) => p.files), edges: parts.flatMap((p) => p.edges) };
}

/**
 * `core/` (2 files, both importing `lib/`) — imported by 6 `app/` files:
 * Ca 6, Ce 2 → I = 2/8. `lib/` (5 files, each importing `vendor/`) — imported
 * by both core files and `other/o.ts`: Ca 3, Ce 5 → I = 5/8. core → lib runs
 * uphill by 3/8; `other/` (one file) is below the support floor.
 */
function stableCoreOnVolatileLib(): FileDependencyGraph {
  return merge(
    {
      files: [file("core/a.ts"), file("core/b.ts")],
      edges: [edge("core/a.ts", "lib/f1.ts", 2), edge("core/b.ts", "lib/f2.ts")],
    },
    files("app", 6, (p) => edge(p, "core/b.ts")),
    files("lib", 5, (p) => edge(p, "vendor/v.ts")),
    { files: [file("vendor/v.ts"), file("other/o.ts")], edges: [edge("other/o.ts", "lib/f3.ts")] },
  );
}

function judge(graph: FileDependencyGraph, options = {}) {
  return detectComponentStableDependencyViolations(buildComponentGraph(graph, []), options);
}

describe("detectComponentStableDependencyViolations", () => {
  it("flags a stable component depending on a less stable one, with component evidence and the file edges carrying it", () => {
    const report = judge(stableCoreOnVolatileLib());

    expect(report.violations).toEqual([
      {
        sourceComponent: "core",
        targetComponent: "lib",
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
        fileEdges: [
          { sourceRelPath: "core/a.ts", targetRelPath: "lib/f1.ts", callWeight: 2 },
          { sourceRelPath: "core/b.ts", targetRelPath: "lib/f2.ts", callWeight: 1 },
        ],
      },
    ]);
  });

  it("does not judge a component whose connection count is below the support floor", () => {
    const report = judge(stableCoreOnVolatileLib(), { minConnectionCount: 9 });

    expect(report.violations).toEqual([]);
    expect(report.summary.excluded.lowConnectionCount).toBeGreaterThan(0);
    expect(DEFAULT_SDP_MIN_CONNECTION_COUNT).toBe(5);
  });

  it("does not judge containment — a component depending on one nested inside it — but counts it", () => {
    // `core` depends on `core/volatile`, nested inside it: composition.
    const graph = merge(
      { files: [file("core/a.ts"), file("core/b.ts")], edges: [edge("core/a.ts", "core/volatile/f1.ts")] },
      files("app", 6, (p) => edge(p, "core/b.ts")),
      files("core/volatile", 5, (p) => edge(p, "vendor/v.ts")),
      { files: [file("vendor/v.ts"), file("other/o.ts")], edges: [edge("other/o.ts", "core/volatile/f3.ts")] },
    );

    const report = judge(graph);

    expect(report.violations).toEqual([]);
    expect(report.summary.excluded.containment).toBe(1);
  });

  it("groups violations by target component, most violations first", () => {
    const graph = merge(
      stableCoreOnVolatileLib(),
      {
        files: [file("base/a.ts")],
        edges: [edge("base/a.ts", "lib/f4.ts")],
      },
      files("users", 6, (p) => edge(p, "base/a.ts")),
    );

    const report = judge(graph);

    expect(report.rootCauses.map((r) => [r.targetComponent, r.violationCount, r.sources])).toEqual([
      ["lib", 2, ["base", "core"]],
    ]);
  });

  it("summarises the component graph and the component edges judged", () => {
    const report = judge(stableCoreOnVolatileLib());

    expect(report.summary).toMatchObject({
      tolerance: DEFAULT_SDP_TOLERANCE,
      minConnectionCount: DEFAULT_SDP_MIN_CONNECTION_COUNT,
      componentCount: 5,
      componentEdgeCount: 4,
      judgedEdgeCount: 3,
      violationCount: 1,
    });
  });

  it("judges only component dependencies carried by an in-scope source file", () => {
    const report = judge(stableCoreOnVolatileLib(), { sourcePathPattern: "other/**" });

    expect(report.violations).toEqual([]);
    expect(report.summary.scope).toEqual({ sourcePathPattern: "other/**", outOfScopeEdgeCount: 3 });
  });

  /**
   * The composition root assembles unstable concretes — that is its JOB — so
   * an SDP delta sourced from one is triage data, not a blind verdict (bd
   * tea-rags-mcp-r8hme.51, design on tea-rags-mcp-89k7k.9). The roots are the
   * DECLARED ones (`.claude/rules/domain-boundaries.md`), fixture uses the
   * real component dirs.
   */
  describe("a violation sourced from a declared composition root carries the annotation", () => {
    /** Same uphill shape as `stableCoreOnVolatileLib`, source at the real root. */
    function bootstrapOnVolatileLib(): FileDependencyGraph {
      return merge(
        {
          files: [file("src/bootstrap/a.ts"), file("src/bootstrap/b.ts")],
          edges: [
            edge("src/bootstrap/a.ts", "src/core/lib/f1.ts", 2),
            edge("src/bootstrap/b.ts", "src/core/lib/f2.ts"),
          ],
        },
        files("app", 6, (p) => edge(p, "src/bootstrap/b.ts")),
        files("src/core/lib", 5, (p) => edge(p, "vendor/v.ts")),
        { files: [file("vendor/v.ts"), file("other/o.ts")], edges: [edge("other/o.ts", "src/core/lib/f3.ts")] },
      );
    }

    it("stamps compositionRoot: true on the violation", () => {
      const report = judge(bootstrapOnVolatileLib());

      expect(report.violations).toHaveLength(1);
      expect(report.violations[0]?.sourceComponent).toBe("src/bootstrap");
      expect(report.violations[0]?.compositionRoot).toBe(true);
    });

    it("keeps the violation reported — annotated, never excluded", () => {
      const report = judge(bootstrapOnVolatileLib());

      expect(report.summary.violationCount).toBe(1);
      expect(report.summary.judgedEdgeCount).toBeGreaterThan(0);
    });

    it("leaves the field absent on a non-root source — not undefined-valued noise", () => {
      const report = judge(stableCoreOnVolatileLib());

      const violation = report.violations[0];
      expect(violation?.sourceComponent).toBe("core");
      expect("compositionRoot" in (violation ?? {})).toBe(false);
    });

    it("annotates a source component nested inside a declared root", () => {
      // bootstrap/config assembles foundation internals (the config/schemas ->
      // churn-walk edge of the bead): still the root's job.
      const graph = merge(
        {
          files: [file("src/bootstrap/config/a.ts"), file("src/bootstrap/config/b.ts")],
          edges: [
            edge("src/bootstrap/config/a.ts", "src/core/lib/f1.ts", 2),
            edge("src/bootstrap/config/b.ts", "src/core/lib/f2.ts"),
          ],
        },
        files("app", 6, (p) => edge(p, "src/bootstrap/config/b.ts")),
        files("src/core/lib", 5, (p) => edge(p, "vendor/v.ts")),
        { files: [file("vendor/v.ts"), file("other/o.ts")], edges: [edge("other/o.ts", "src/core/lib/f3.ts")] },
      );

      const report = judge(graph);

      expect(report.violations[0]?.sourceComponent).toBe("src/bootstrap/config");
      expect(report.violations[0]?.compositionRoot).toBe(true);
    });
  });

  /**
   * callWeight 0 has four causes the weight alone cannot separate (a constant,
   * a type used as a value, a JSX element, a re-export — the
   * `FileDependencyEdge` docblock), so the evidence rows carry the export names
   * the edge's imports bind (bd tea-rags-mcp-89k7k.2). The shape below is the
   * live one that started the bead: api/public/app.ts imports the RUNTIME
   * `formatIndexDriftReport` plus the TYPE `IndexDriftReporter` from
   * maintenance/drift.
   */
  describe("evidence rows carry the file edge's export names", () => {
    /** Same uphill shape as `stableCoreOnVolatileLib`, one edge per name shape. */
    function graphWithNamedEdges(): FileDependencyGraph {
      return merge(
        {
          files: [file("core/plain.ts"), file("core/re.ts"), file("core/type.ts")],
          edges: [
            edge("core/plain.ts", "lib/f1.ts"),
            edge("core/re.ts", "lib/f2.ts", 0, { reexportedExportNames: ["formatIndexDriftReport"] }),
            edge("core/type.ts", "lib/f3.ts", 0, { importedExportNames: ["IndexDriftReporter"] }),
          ],
        },
        files("app", 6, (p) => edge(p, "core/plain.ts")),
        files("lib", 5, (p) => edge(p, "vendor/v.ts")),
        { files: [file("vendor/v.ts"), file("other/o.ts")], edges: [edge("other/o.ts", "lib/f4.ts")] },
      );
    }

    it("passes reexportedExportNames and importedExportNames through to the evidence rows", () => {
      const report = judge(graphWithNamedEdges());

      expect(report.violations[0]?.fileEdges).toEqual([
        { sourceRelPath: "core/plain.ts", targetRelPath: "lib/f1.ts", callWeight: 1 },
        {
          sourceRelPath: "core/re.ts",
          targetRelPath: "lib/f2.ts",
          callWeight: 0,
          reexportedExportNames: ["formatIndexDriftReport"],
        },
        {
          sourceRelPath: "core/type.ts",
          targetRelPath: "lib/f3.ts",
          callWeight: 0,
          importedExportNames: ["IndexDriftReporter"],
        },
      ]);
    });

    it("leaves both fields absent on an edge carrying neither — not undefined-valued noise", () => {
      const report = judge(graphWithNamedEdges());

      const plain = report.violations[0]?.fileEdges[0];
      expect(Object.keys(plain ?? {}).sort()).toEqual(["callWeight", "sourceRelPath", "targetRelPath"]);
    });
  });
});
