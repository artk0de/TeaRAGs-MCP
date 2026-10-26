/**
 * The `get_architecture_report` TOOL view (bd tea-rags-mcp-9ah49): the flat
 * internal report grouped per detector, evidence arrays capped, the explained
 * pairs reduced to a count, and one `next` drill-down per trimmed group. The
 * internal response stays flat for review_changes and restructure.
 */

import { describe, expect, it } from "vitest";

import { silentCouplingArchitectureViolations } from "../../../../../../src/core/api/internal/ops/architecture-report-ops.js";
import {
  architectureReportViewOf,
  presentArchitectureReport,
} from "../../../../../../src/core/api/internal/ops/architecture-report/architecture-report-presentation.js";
import type { GetArchitectureReportResponse } from "../../../../../../src/core/api/public/dto/architecture.js";
import { formatMcpResponse } from "../../../../../../src/core/api/tools/format.js";
import type { WorkingTreeMarker } from "../../../../../../src/core/contracts/types/working-tree.js";
import type { SilentCouplingViolation } from "../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

const MARKER: WorkingTreeMarker = {
  tree: "/repo/.claude/worktrees/feature",
  indexedCommit: "a".repeat(40),
  treeCommit: "b".repeat(40),
  indexedDirty: false,
  changedFiles: 0,
  deletedFiles: 0,
  floors: [],
  project: "tea-rags",
};

const files = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}/f${i}.ts`);

function report(): GetArchitectureReportResponse {
  const violations = [
    {
      detector: "stableDependencies",
      sourceComponent: "src/a",
      targetComponent: "src/b",
      evidence: {
        fileEdgeCount: 5,
        fileEdges: files(5, "src/a"),
        drillDown: { tool: "get_callers", files: files(5, "src/a"), hint: "same hint" },
      },
    },
    {
      detector: "stableDependencies",
      sourceComponent: "src/c",
      targetComponent: "src/b",
      evidence: {
        fileEdgeCount: 2,
        fileEdges: files(2, "src/c"),
        drillDown: { tool: "get_callers", files: files(2, "src/c"), hint: "same hint" },
      },
    },
    {
      detector: "shotgunSurgery",
      component: "src/d",
      evidence: {
        carrierFiles: files(5, "src/d"),
        sampleChanges: [{ commit: "c1", files: files(4, "src/d") }],
        drillDown: { tool: "find_co_changed", files: ["src/d/x.ts"], hint: "hint one" },
      },
      tierEvidence: { admittedCarrierPairs: [["a", "b"]] },
    },
    {
      detector: "shotgunSurgery",
      component: "src/e",
      evidence: {
        carrierFiles: files(2, "src/e"),
        drillDown: { tool: "find_co_changed", files: ["src/e/x.ts"], hint: "hint two" },
      },
    },
    { detector: "layering", kind: "island", component: "src/f", evidence: { height: 1 } },
  ];
  return {
    workingTree: MARKER,
    pathPattern: "src/**",
    summary: {
      silentCoupling: {
        violationCount: 7,
        excluded: { explainedBySharedNeighbour: 5 },
        explainedPairs: [{ detector: "silentCoupling" }, { detector: "silentCoupling" }],
      },
      layering: { levelCount: 4 },
    },
    rootCauses: [],
    violations,
  } as unknown as GetArchitectureReportResponse;
}

const request = { project: "tea-rags", path: MARKER.tree, pathPattern: "src/**", limit: 20 };

function present(extra: Record<string, unknown> = {}, reportId?: string) {
  return presentArchitectureReport(report(), architectureReportViewOf({ ...request, ...extra }, reportId), MARKER);
}

describe("presentArchitectureReport", () => {
  it("groups violations per detector in the report's order, rows without the detector key, tables without union columns", () => {
    const view = present();

    expect(Object.keys(view.violations)).toEqual(["stableDependencies", "shotgunSurgery", "layering"]);
    expect(view.violations.layering).toEqual([{ kind: "island", component: "src/f", evidence: { height: 1 } }]);

    const wire = JSON.parse(formatMcpResponse(view).content[0].text) as {
      violations: Record<string, { columns: string[]; rows: unknown[][] }>;
    };
    expect(wire.violations.stableDependencies.columns).not.toContain("detector");
    expect(wire.violations.stableDependencies.columns).not.toContain("component");
    expect(wire.violations.shotgunSurgery.columns).not.toContain("sourceComponent");
  });

  it("hoists a drill-down hint every row of a group shares; keeps differing hints on their rows", () => {
    const view = present();

    expect(view.violationDrillDownHints).toEqual({ stableDependencies: "same hint" });
    const sdp = view.violations.stableDependencies as unknown as { evidence: { drillDown: Record<string, unknown> } }[];
    expect(sdp.every((v) => !("hint" in v.evidence.drillDown))).toBe(true);
    const shotgun = view.violations.shotgunSurgery as unknown as { evidence: { drillDown: { hint: string } } }[];
    expect(shotgun.map((v) => v.evidence.drillDown.hint)).toEqual(["hint one", "hint two"]);
  });

  it("hoists the silent-coupling groups' templated hint even beside pair rows that carry no drill-down (bd tea-rags-mcp-4c129)", () => {
    const pair = (relPathA: string, relPathB: string, support: number, strength: number): SilentCouplingViolation => ({
      relPathA,
      relPathB,
      support,
      confidenceAB: 0.9,
      confidenceBA: 0.8,
      lift: 3,
      strength,
      lastCoChangeAt: 1_700_000_000,
      sampleCommits: ["c1"],
      structuralVisibility: "one-walked",
      directoryRelation: "disjoint",
    });
    const violations = silentCouplingArchitectureViolations(
      [
        pair("app/a.ts", "config/en.yml", 30, 0.71),
        pair("app/b.ts", "config/en.yml", 20, 0.66),
        pair("lib/x.ts", "lib/y.ts", 9, 0.64),
        pair("app/c.ts", "config/ru.yml", 8, 0.6),
        pair("app/d.ts", "config/ru.yml", 7, 0.58),
      ],
      50,
    );
    const flat: GetArchitectureReportResponse = { ...report(), violations };

    const view = presentArchitectureReport(flat, architectureReportViewOf(request), MARKER);

    expect(view.violationDrillDownHints?.silentCoupling).toBe(
      "call find_co_changed(files: drillDown.files, limit: drillDown.limit) to list this file's co-change partners",
    );
    const rows = view.violations.silentCoupling as unknown as { evidence: { drillDown?: Record<string, unknown> } }[];
    const drills = rows.flatMap((row) => (row.evidence.drillDown ? [row.evidence.drillDown] : []));
    expect(drills.map((drill) => drill.files)).toEqual([["config/en.yml"], ["config/ru.yml"]]);
    expect(drills.every((drill) => !("hint" in drill))).toBe(true);
    expect(rows.filter((row) => !row.evidence.drillDown)).toHaveLength(1);
  });

  it("caps evidence arrays at 3 with a sibling count when the row has none; drill-down args stay whole", () => {
    const view = present();

    const [sdp] = view.violations.stableDependencies as unknown as {
      evidence: Record<string, unknown> & { drillDown: { files: string[] } };
    }[];
    expect(sdp.evidence.fileEdges).toEqual(files(3, "src/a"));
    expect(sdp.evidence.fileEdgeCount).toBe(5);
    expect(sdp.evidence).not.toHaveProperty("fileEdgesCount");
    expect(sdp.evidence.drillDown.files).toHaveLength(5);

    const [shotgun] = view.violations.shotgunSurgery as unknown as {
      evidence: Record<string, unknown> & { sampleChanges: { files: string[]; filesCount: number }[] };
    }[];
    expect(shotgun.evidence.carrierFiles).toEqual(files(3, "src/d"));
    expect(shotgun.evidence.carrierFilesCount).toBe(5);
    expect(shotgun.evidence.sampleChanges[0].files).toHaveLength(3);
    expect(shotgun.evidence.sampleChanges[0].filesCount).toBe(4);
    expect(view.evidenceTrimmed).toEqual({ limit: 3 });
  });

  it("restores every evidence entry under evidenceLimit all, with no trim marker and no next", () => {
    const view = present({ evidenceLimit: "all" });

    const [shotgun] = view.violations.shotgunSurgery as unknown as { evidence: Record<string, unknown> }[];
    expect(shotgun.evidence.carrierFiles).toEqual(files(5, "src/d"));
    expect(shotgun.evidence).not.toHaveProperty("carrierFilesCount");
    expect(view).not.toHaveProperty("evidenceTrimmed");
    expect(view).not.toHaveProperty("next");
  });

  it("returns only the groups the detectors selector names", () => {
    const view = present({ detectors: ["layering"] });

    expect(Object.keys(view.violations)).toEqual(["layering"]);
    expect(view).not.toHaveProperty("evidenceTrimmed");
  });

  it("reduces the explained pairs to their TOTAL count, not the limit-capped list's length; lists them on includeExplainedPairs", () => {
    const counted = present().summary.silentCoupling;
    expect(counted.explainedPairCount).toBe(5);
    expect(counted).not.toHaveProperty("explainedPairs");

    const listed = present({ includeExplainedPairs: true }).summary.silentCoupling;
    expect(listed.explainedPairCount).toBe(5);
    expect(listed.explainedPairs).toHaveLength(2);
  });

  it("emits one next per trimmed group: the same call on that detector with evidenceLimit all, addressed to the tree", () => {
    const view = present({ includeExplainedPairs: true });

    expect(view.next).toEqual([
      {
        tool: "get_architecture_report",
        args: {
          project: "tea-rags",
          path: MARKER.tree,
          pathPattern: "src/**",
          limit: 20,
          detectors: ["stableDependencies"],
          evidenceLimit: "all",
        },
        why: expect.any(String) as string,
      },
      {
        tool: "get_architecture_report",
        args: {
          project: "tea-rags",
          path: MARKER.tree,
          pathPattern: "src/**",
          limit: 20,
          detectors: ["shotgunSurgery"],
          evidenceLimit: "all",
        },
        why: expect.any(String) as string,
      },
    ]);
  });

  it("carries a reportId into the next args when the view has one", () => {
    const view = present({}, "r-1");

    expect(view.next?.map((call) => call.args.reportId)).toEqual(["r-1", "r-1"]);
  });

  it("keeps every summary total and the input report untouched", () => {
    const source = report();
    const view = presentArchitectureReport(source, architectureReportViewOf(request), MARKER);

    expect(view.summary.layering).toEqual({ levelCount: 4 });
    expect(view.summary.silentCoupling.violationCount).toBe(7);
    expect(view.pathPattern).toBe("src/**");
    expect(view.workingTree).toBe(MARKER);
    expect(source).toEqual(report());
  });
});
