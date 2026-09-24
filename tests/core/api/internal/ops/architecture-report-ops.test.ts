/**
 * ArchitectureReportOps (bd tea-rags-mcp-94hd9) — the query behind
 * `get_architecture_report`: reads the file dependency graph from a codegraph
 * handle, runs the Stable Dependencies detector, and shapes the typed report.
 */
import { describe, expect, it, vi } from "vitest";

import { ArchitectureReportOps } from "../../../../../src/core/api/internal/ops/architecture-report-ops.js";
import type { FileDependencyGraph } from "../../../../../src/core/contracts/types/codegraph.js";

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

function graphDb(g: FileDependencyGraph = graph()) {
  return { readFileDependencyGraph: vi.fn().mockResolvedValue(g) };
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
        lowConnectionCount: g.edges.length - 3 - 1,
        privateCollaborators: 1,
      },
      exclusionReasons: {
        noSymbolEndpoints: "no-symbol endpoint: barrel, type-only or object-literal module",
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

describe("ArchitectureReportOps.empty", () => {
  it("is the report of a collection with no graph database: zero edges read", () => {
    const report = ArchitectureReportOps.empty({ pathPattern: "src/**" });

    expect(report.violations).toEqual([]);
    expect(report.rootCauses).toEqual([]);
    expect(report.pathPattern).toBe("src/**");
    expect(report.summary.stableDependencies.edgeCount).toBe(0);
    expect(report.summary.stableDependencies.judgedEdgeCount).toBe(0);
  });
});
