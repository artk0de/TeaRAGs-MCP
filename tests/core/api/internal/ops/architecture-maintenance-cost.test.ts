/**
 * Maintenance cost of an architecture violation (bd tea-rags-mcp-r8hme.20):
 * each file's git readings positioned in the collection's own distribution,
 * churn the base, bug-fix share and recency raising it. A violation is scored
 * by the mean cost position of the files on the edges that make it, read as a
 * percentile against a same-size random-file null (bd tea-rags-mcp-afyku), and
 * lists rank costliest first.
 */
import { describe, expect, it } from "vitest";

import {
  architectureViolationCarrierFiles,
  ComponentEdgeCarrierIndex,
  FileMaintenanceCostModel,
  meanPositionPercentile,
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
      costPosition: 1,
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

describe("FileMaintenanceCostModel#fileCost — position of the cost itself (bd tea-rags-mcp-afyku)", () => {
  it("positions each file's cost among every measured file's cost, ties at their mid-rank", () => {
    const model = new FileMaintenanceCostModel(corpus());

    // Costs: cold 0, oneShotFix 0, warm 0.370, hot 0.889 — the two zero-cost
    // files share ranks 0 and 1, so both read their mean rank, 0.5 / 3.
    expect(model.fileCost("hot.ts")?.costPosition).toBe(1);
    expect(model.fileCost("warm.ts")?.costPosition).toBe(0.667);
    expect(model.fileCost("cold.ts")?.costPosition).toBe(0.167);
    expect(model.fileCost("oneShotFix.ts")?.costPosition).toBe(0.167);
  });

  it("reads the null's centre, 0.5, when no file stands out — a flat corpus or a single file", () => {
    const flat = new FileMaintenanceCostModel(
      signals({
        "a.ts": { commitCount: 3, bugFixRate: 10, ageDays: 5 },
        "b.ts": { commitCount: 3, bugFixRate: 10, ageDays: 5 },
      }),
    );
    const single = new FileMaintenanceCostModel(signals({ "a.ts": { commitCount: 3, bugFixRate: 10, ageDays: 5 } }));

    expect(flat.fileCost("a.ts")?.costPosition).toBe(0.5);
    expect(single.fileCost("a.ts")?.costPosition).toBe(0.5);
  });
});

describe("meanPositionPercentile — the same-size random-file null (bd tea-rags-mcp-afyku)", () => {
  it("equals the raw position for one carrier: one uniform draw is its own CDF", () => {
    for (const mean of [0, 0.13, 0.5, 0.77, 1]) {
      expect(meanPositionPercentile(mean, 1)).toBeCloseTo(mean, 12);
    }
  });

  it("is the exact Irwin–Hall CDF of n × mean — two carriers follow the triangular law", () => {
    // P(U1 + U2 ≤ 1.2) = 1 − 0.8² / 2.
    expect(meanPositionPercentile(0.6, 2)).toBeCloseTo(0.68, 12);
    // P(U1 + U2 + U3 ≤ 0.9) = 0.9³ / 6.
    expect(meanPositionPercentile(0.3, 3)).toBeCloseTo(0.1215, 12);
  });

  it("scores a larger set with the same above-centre mean HIGHER — the mean of more files is harder to reach by chance", () => {
    const pair = meanPositionPercentile(0.6, 2);
    const component = meanPositionPercentile(0.6, 40);

    expect(component).toBeGreaterThan(pair);
    expect(pair).toBeGreaterThan(0.6);
  });

  it("scores a larger set with the same below-centre mean LOWER, and reads 0.5 at the centre for every size", () => {
    expect(meanPositionPercentile(0.4, 40)).toBeLessThan(meanPositionPercentile(0.4, 2));
    for (const n of [1, 2, 7, 40, 400, 5000]) {
      expect(meanPositionPercentile(0.5, n)).toBeCloseTo(0.5, 6);
    }
  });

  it("stays a monotone probability across the exact-to-normal switch, at every size", () => {
    let previous = 0;
    for (let n = 1; n <= 600; n++) {
      const p = meanPositionPercentile(0.52, n);
      expect(p).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(p).toBeLessThanOrEqual(1);
      previous = p;
    }
    expect(meanPositionPercentile(0.6, 5000)).toBeCloseTo(1, 12);
    expect(meanPositionPercentile(0.4, 5000)).toBeCloseTo(0, 12);
  });
});

describe("FileMaintenanceCostModel#costOf", () => {
  it("scores the measured carriers' mean cost position against a same-size null, keeps the mean, names the costliest", () => {
    const measured = new FileMaintenanceCostModel(corpus()).costOf(["hot.ts", "cold.ts", "unknown.ts", "hot.ts"]);

    // Positions hot 1, cold 1/6 → mean 7/12; P(U1 + U2 ≤ 7/6) = 1 − (5/6)² / 2.
    expect(measured?.cost).toEqual({
      score: 0.653,
      meanPosition: 0.583,
      fileCount: 3,
      measuredFileCount: 2,
      hottestFile: expect.objectContaining({ relPath: "hot.ts", cost: 0.889, costPosition: 1 }),
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
    expect(ranked[0].maintenanceCost?.score).toBe(1);
    expect(ranked[4]).not.toHaveProperty("maintenanceCost");
  });

  it("ranks a 40-file violation above a 2-file one whose carriers have the same above-centre mean", () => {
    // 100 files with distinct commit counts: file i sits at cost position i / 99.
    const hundred = new Map<string, GitFileMaintenanceSignals>();
    for (let i = 0; i < 100; i++) hundred.set(`f${i}.ts`, { commitCount: i + 1, bugFixRate: 0, ageDays: 1 });
    const model = new FileMaintenanceCostModel(hundred);
    // Both means are 59.5 / 99: the pair {f50, f69} and the forty files f40..f79.
    const pair = { id: "pair", files: ["f50.ts", "f69.ts"] };
    const component = { id: "component", files: Array.from({ length: 40 }, (_, k) => `f${40 + k}.ts`) };

    const ranked = rankByMaintenanceCost([pair, component], (i) => i.files, model);

    expect(ranked.map((i) => i.id)).toEqual(["component", "pair"]);
    expect(ranked[0].maintenanceCost?.meanPosition).toBe(ranked[1].maintenanceCost?.meanPosition);
    expect(ranked[0].maintenanceCost?.score).toBeGreaterThan(ranked[1].maintenanceCost?.score ?? 1);
  });

  it("leaves the list untouched without a model — the git trajectory is unavailable", () => {
    const ranked = rankByMaintenanceCost(items, (i) => i.files, undefined);

    expect(ranked.map((i) => i.id)).toEqual(["cold", "unmeasured", "hot", "alsoCold", "warm"]);
    expect(ranked.some((i) => "maintenanceCost" in i)).toBe(false);
  });
});

describe("architectureViolationCarrierFiles — the files on the edges that make the violation (bd tea-rags-mcp-afyku)", () => {
  // core: a, b (on boundary edges) and inner (internal only); lib: c, e; app: x.
  // Component edges: core → lib (a→c, b→e), app → core (x→a), lib → core (c→b).
  const edge = (sourceRelPath: string, targetRelPath: string) => ({ sourceRelPath, targetRelPath, callWeight: 1 });
  const index = new ComponentEdgeCarrierIndex(
    new Map([
      ["core/a.ts", "core"],
      ["core/b.ts", "core"],
      ["core/inner.ts", "core"],
      ["lib/c.ts", "lib"],
      ["lib/e.ts", "lib"],
      ["app/x.ts", "app"],
    ]),
    [
      {
        sourceComponent: "core",
        targetComponent: "lib",
        fileEdges: [edge("core/a.ts", "lib/c.ts"), edge("core/b.ts", "lib/e.ts")],
      },
      { sourceComponent: "app", targetComponent: "core", fileEdges: [edge("app/x.ts", "core/a.ts")] },
      { sourceComponent: "lib", targetComponent: "core", fileEdges: [edge("lib/c.ts", "core/b.ts")] },
    ],
  );

  it("reads a file pair's endpoints", () => {
    expect(architectureViolationCarrierFiles({ sourceRelPath: "x.ts", targetRelPath: "y.ts" }, index)).toEqual([
      "x.ts",
      "y.ts",
    ]);
  });

  it("reads a shared endpoint and its partners", () => {
    expect(
      architectureViolationCarrierFiles(
        { relPath: "hub.ts", partners: [{ relPath: "p1.ts" }, { relPath: "p2.ts" }] },
        index,
      ),
    ).toEqual(["hub.ts", "p1.ts", "p2.ts"]);
  });

  it("carries an SDP violation on EVERY file edge of its component dependency — not the capped evidence, not the whole components", () => {
    const carriers = architectureViolationCarrierFiles(
      {
        detector: "stableDependencies",
        sourceComponent: "core",
        targetComponent: "lib",
        evidence: { fileEdges: [edge("core/a.ts", "lib/c.ts")] },
      },
      index,
    );

    expect(carriers.sort()).toEqual(["core/a.ts", "core/b.ts", "lib/c.ts", "lib/e.ts"]);
  });

  it("carries a knot on the file edges of its feedback-arc set", () => {
    const carriers = architectureViolationCarrierFiles(
      {
        kind: "knot",
        components: ["core", "lib"],
        feedbackArcSet: [{ sourceComponent: "lib", targetComponent: "core", fileEdges: [] }],
      },
      index,
    );

    expect(carriers.sort()).toEqual(["core/b.ts", "lib/c.ts"]);
  });

  it("carries a composition cycle on the file edges between each parent and its nested component, both ways", () => {
    const carriers = architectureViolationCarrierFiles(
      {
        kind: "compositionCycle",
        components: ["core", "lib"],
        nestedPairs: [{ parentComponent: "core", nestedComponent: "lib" }],
      },
      index,
    );

    expect(carriers.sort()).toEqual(["core/a.ts", "core/b.ts", "lib/c.ts", "lib/e.ts"]);
  });

  it("carries a hub on its own files that sit on its afferent or efferent edges", () => {
    const carriers = architectureViolationCarrierFiles({ detector: "hubLikeDependency", component: "core" }, index);

    expect(carriers.sort()).toEqual(["core/a.ts", "core/b.ts"]);
  });

  it("carries a zone-of-pain component on the files its dependents reach; a zone-of-uselessness one on all its files", () => {
    const pain = (component: string) =>
      architectureViolationCarrierFiles({ detector: "mainSequence", component, evidence: { zone: "pain" } }, index);

    expect(pain("core").sort()).toEqual(["core/a.ts", "core/b.ts"]);
    expect(pain("lib")).toEqual(["lib/c.ts", "lib/e.ts"]);
    expect(
      architectureViolationCarrierFiles(
        { detector: "mainSequence", component: "core", evidence: { zone: "uselessness" } },
        index,
      ).sort(),
    ).toEqual(["core/a.ts", "core/b.ts", "core/inner.ts"]);
  });

  it("carries an island on all its files — nothing depends on any of them", () => {
    expect(architectureViolationCarrierFiles({ kind: "island", component: "app" }, index)).toEqual(["app/x.ts"]);
  });

  it("falls back to the evidence edges, then to the components' files, when the graph holds no such edge", () => {
    expect(
      architectureViolationCarrierFiles(
        { sourceComponent: "app", targetComponent: "lib", evidence: { fileEdges: [edge("app/x.ts", "lib/e.ts")] } },
        index,
      ),
    ).toEqual(["app/x.ts", "lib/e.ts"]);
    expect(architectureViolationCarrierFiles({ sourceComponent: "app", targetComponent: "lib" }, index)).toEqual([
      "app/x.ts",
      "lib/c.ts",
      "lib/e.ts",
    ]);
    expect(architectureViolationCarrierFiles({ component: "nowhere" }, index)).toEqual([]);
  });
});
