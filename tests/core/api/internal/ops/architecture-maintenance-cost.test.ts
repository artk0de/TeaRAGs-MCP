/**
 * Maintenance cost of an architecture violation (bd tea-rags-mcp-r8hme.20):
 * each file's git readings positioned in the collection's own distribution,
 * churn the base, bug-fix share and recency raising it; a violation costs the
 * mean of its carrying files, and lists rank costliest first.
 */
import { describe, expect, it } from "vitest";

import {
  architectureViolationCarrierFiles,
  FileMaintenanceCostModel,
  filesByComponent,
  rankByMaintenanceCost,
} from "../../../../../src/core/api/internal/ops/architecture-maintenance-cost.js";
import type { GitFileMaintenanceSignals } from "../../../../../src/core/api/public/dto/architecture.js";

function signals(entries: Record<string, GitFileMaintenanceSignals>): Map<string, GitFileMaintenanceSignals> {
  return new Map(Object.entries(entries));
}

/** Four files spanning the distribution: cold, warm, hot, and a buggy one-commit file. */
function corpus(): Map<string, GitFileMaintenanceSignals> {
  return signals({
    "cold.ts": { commitCount: 1, bugFixRate: 0, ageDays: 400 },
    "warm.ts": { commitCount: 5, bugFixRate: 20, ageDays: 100 },
    "hot.ts": { commitCount: 30, bugFixRate: 60, ageDays: 1 },
    "oneShotFix.ts": { commitCount: 1, bugFixRate: 100, ageDays: 2 },
  });
}

describe("FileMaintenanceCostModel#fileCost", () => {
  it("positions each signal in the collection's own distribution: least active 0, most active 1", () => {
    const model = new FileMaintenanceCostModel(corpus());

    expect(model.fileCost("hot.ts")).toEqual({
      relPath: "hot.ts",
      cost: 0.889,
      churn: 1,
      bugFix: 0.667,
      recency: 1,
      commitCount: 30,
      bugFixRate: 60,
      ageDays: 1,
    });
    expect(model.fileCost("cold.ts")).toMatchObject({ cost: 0, churn: 0, bugFix: 0, recency: 0 });
  });

  it("costs a file nobody changes nothing, whatever the bug-fix share of its one commit says", () => {
    const cost = new FileMaintenanceCostModel(corpus()).fileCost("oneShotFix.ts");

    expect(cost).toMatchObject({ churn: 0, bugFix: 1, cost: 0 });
  });

  it("reads 0 on a flat distribution — nothing stands out when every file is alike", () => {
    const model = new FileMaintenanceCostModel(
      signals({
        "a.ts": { commitCount: 3, bugFixRate: 10, ageDays: 5 },
        "b.ts": { commitCount: 3, bugFixRate: 10, ageDays: 5 },
      }),
    );

    expect(model.fileCost("a.ts")).toMatchObject({ churn: 0, bugFix: 0, recency: 0, cost: 0 });
  });

  it("answers undefined for a file the git trajectory never measured", () => {
    expect(new FileMaintenanceCostModel(corpus()).fileCost("unknown.ts")).toBeUndefined();
  });

  it("scales with the corpus, not with a constant: the same commit count ranks differently in a busier repo", () => {
    const quiet = new FileMaintenanceCostModel(
      signals({
        "x.ts": { commitCount: 10, bugFixRate: 0, ageDays: 1 },
        "y.ts": { commitCount: 2, bugFixRate: 0, ageDays: 1 },
      }),
    );
    const busy = new FileMaintenanceCostModel(
      signals({
        "x.ts": { commitCount: 10, bugFixRate: 0, ageDays: 1 },
        "y.ts": { commitCount: 200, bugFixRate: 0, ageDays: 1 },
      }),
    );

    expect(quiet.fileCost("x.ts")?.churn).toBe(1);
    expect(busy.fileCost("x.ts")?.churn).toBe(0);
  });
});

describe("FileMaintenanceCostModel#costOf", () => {
  it("averages the measured carrying files and names the costliest", () => {
    const measured = new FileMaintenanceCostModel(corpus()).costOf(["hot.ts", "cold.ts", "unknown.ts", "hot.ts"]);

    expect(measured?.cost).toEqual({
      score: 0.444,
      fileCount: 3,
      measuredFileCount: 2,
      hottestFile: expect.objectContaining({ relPath: "hot.ts", cost: 0.889 }),
    });
  });

  it("answers undefined when no carrying file is measured", () => {
    expect(new FileMaintenanceCostModel(corpus()).costOf(["unknown.ts"])).toBeUndefined();
    expect(new FileMaintenanceCostModel(corpus()).costOf([])).toBeUndefined();
  });
});

describe("rankByMaintenanceCost", () => {
  const items = [
    { id: "cold", files: ["cold.ts"] },
    { id: "unmeasured", files: ["unknown.ts"] },
    { id: "hot", files: ["hot.ts"] },
    { id: "alsoCold", files: ["oneShotFix.ts"] },
    { id: "warm", files: ["warm.ts"] },
  ];

  it("lists costliest first, keeps detector order on ties, sinks unmeasured items untagged", () => {
    const ranked = rankByMaintenanceCost(items, (i) => i.files, new FileMaintenanceCostModel(corpus()));

    expect(ranked.map((i) => i.id)).toEqual(["hot", "warm", "cold", "alsoCold", "unmeasured"]);
    expect(ranked[0].maintenanceCost?.score).toBe(0.889);
    expect(ranked[4]).not.toHaveProperty("maintenanceCost");
  });

  it("leaves the list untouched without a model — the git trajectory is unavailable", () => {
    const ranked = rankByMaintenanceCost(items, (i) => i.files, undefined);

    expect(ranked.map((i) => i.id)).toEqual(["cold", "unmeasured", "hot", "alsoCold", "warm"]);
    expect(ranked.some((i) => "maintenanceCost" in i)).toBe(false);
  });
});

describe("architectureViolationCarrierFiles", () => {
  const filesOf = filesByComponent(
    new Map([
      ["core/a.ts", "core"],
      ["core/b.ts", "core"],
      ["lib/c.ts", "lib"],
    ]),
  );

  it("reads a file pair's endpoints", () => {
    expect(architectureViolationCarrierFiles({ sourceRelPath: "x.ts", targetRelPath: "y.ts" }, filesOf)).toEqual([
      "x.ts",
      "y.ts",
    ]);
  });

  it("reads a shared endpoint and its partners", () => {
    expect(
      architectureViolationCarrierFiles(
        { relPath: "hub.ts", partners: [{ relPath: "p1.ts" }, { relPath: "p2.ts" }] },
        filesOf,
      ),
    ).toEqual(["hub.ts", "p1.ts", "p2.ts"]);
  });

  it("prefers the file edges behind a component edge over the components' whole file sets", () => {
    const carriers = architectureViolationCarrierFiles(
      {
        sourceComponent: "core",
        targetComponent: "lib",
        evidence: { fileEdges: [{ sourceRelPath: "core/a.ts", targetRelPath: "lib/c.ts", callWeight: 1 }] },
      },
      filesOf,
    );

    expect(carriers).toEqual(["core/a.ts", "lib/c.ts"]);
  });

  it("reads a knot's feedback-arc file edges", () => {
    const carriers = architectureViolationCarrierFiles(
      {
        components: ["core", "lib"],
        evidence: {
          feedbackArcSet: [{ fileEdges: [{ sourceRelPath: "lib/c.ts", targetRelPath: "core/b.ts", callWeight: 2 }] }],
        },
      },
      filesOf,
    );

    expect(carriers).toEqual(["lib/c.ts", "core/b.ts"]);
  });

  it("falls back to the files of the components a component-level violation names", () => {
    expect(architectureViolationCarrierFiles({ component: "core" }, filesOf)).toEqual(["core/a.ts", "core/b.ts"]);
    expect(architectureViolationCarrierFiles({ components: ["lib", "core"] }, filesOf)).toEqual([
      "lib/c.ts",
      "core/a.ts",
      "core/b.ts",
    ]);
    expect(architectureViolationCarrierFiles({ component: "nowhere" }, filesOf)).toEqual([]);
  });
});
