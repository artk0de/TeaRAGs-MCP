/**
 * Maintenance cost of an architecture violation (bd tea-rags-mcp-r8hme.20):
 * each file's git readings positioned in the collection's own distribution,
 * churn the base, bug-fix share and recency raising it. A violation is scored
 * by the mean cost position of the files on the edges that make it, shrunk
 * toward the centre by how much its carrier count can be trusted against the
 * spread of the report's violations (empirical Bayes, bd tea-rags-mcp-afyku),
 * and lists rank costliest first.
 */
import { describe, expect, it } from "vitest";

import {
  architectureViolationCarrierFiles,
  ComponentEdgeCarrierIndex,
  FileMaintenanceCostModel,
  maintenanceCostFamily,
  MaintenanceCostShrinkage,
  rankByMaintenanceCost,
  rankFamiliesByMaintenanceCost,
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

describe("MaintenanceCostShrinkage — empirical-Bayes shrunken mean over the report's violations (bd tea-rags-mcp-afyku)", () => {
  /** A violation's carrier statistic: its mean cost position over n measured carriers. */
  const sample = (meanPosition: number, measuredFileCount: number) => ({ meanPosition, measuredFileCount });

  it("estimates n₀ = (1/12) / σ²_between, σ²_between by method of moments over the violation means", () => {
    // Means 0.2, 0.5, 0.8 over 2 carriers each: unbiased Var = 0.09, null term 1/24.
    const shrinkage = MaintenanceCostShrinkage.over([sample(0.2, 2), sample(0.5, 2), sample(0.8, 2)]);
    const priorFileCount = 1 / 12 / (0.09 - 1 / 24);

    expect(shrinkage.priorFileCount).toBeCloseTo(priorFileCount, 12);
    expect(shrinkage.scoreOf(sample(0.8, 2))).toBeCloseTo(0.5 + (0.3 * 2) / (2 + priorFileCount), 12);
  });

  it("keeps a huge carrier set at its own mean and ranks it BELOW a 2-carrier set far above centre when violations spread", () => {
    const knot = sample(0.51, 7579);
    const pair = sample(0.95, 2);
    const shrinkage = MaintenanceCostShrinkage.over([knot, pair, sample(0.05, 3), sample(0.97, 4), sample(0.1, 2)]);

    expect(shrinkage.scoreOf(knot)).toBeCloseTo(0.51, 3);
    expect(shrinkage.scoreOf(pair)).toBeGreaterThan(shrinkage.scoreOf(knot) + 0.2);
    expect(shrinkage.scoreOf(pair)).toBeLessThan(0.95);
  });

  it("pulls a one-carrier reading toward 0.5 — one file is mostly noise", () => {
    const single = sample(0.99, 1);
    const shrinkage = MaintenanceCostShrinkage.over([single, sample(0.2, 3), sample(0.8, 5), sample(0.4, 2)]);

    expect(shrinkage.scoreOf(single)).toBeGreaterThan(0.5);
    expect(shrinkage.scoreOf(single)).toBeLessThan(0.89);
  });

  it("scores every violation 0.5 when the means spread no more than carrier noise predicts", () => {
    // Var of 0.4 / 0.6 / 0.5 over one carrier each = 0.01 < 1/12: no between-violation spread is evidenced.
    const samples = [sample(0.4, 1), sample(0.6, 1), sample(0.5, 1)];
    const shrinkage = MaintenanceCostShrinkage.over(samples);

    expect(shrinkage.priorFileCount).toBe(Number.POSITIVE_INFINITY);
    for (const s of samples) expect(shrinkage.scoreOf(s)).toBe(0.5);
  });

  it("scores 0.5 with fewer than two violations — a spread needs two means to exist", () => {
    expect(MaintenanceCostShrinkage.over([sample(0.9, 3)]).scoreOf(sample(0.9, 3))).toBe(0.5);
    expect(MaintenanceCostShrinkage.over([]).priorFileCount).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("FileMaintenanceCostModel#costOf", () => {
  it("measures the carriers' mean cost position, counts them, names the costliest — no score without a population", () => {
    const measured = new FileMaintenanceCostModel(corpus()).costOf(["hot.ts", "cold.ts", "unknown.ts", "hot.ts"]);

    // Positions hot 1, cold 1/6 → mean 7/12.
    expect(measured).toEqual({
      meanPosition: 7 / 12,
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
    // Means 1, 2/3, 1/6, 1/6 over one carrier: Var 1/6, null 1/12 → n₀ = 1, so hot reads 0.5 + 0.5 / 2.
    expect(ranked[0].maintenanceCost?.score).toBe(0.75);
    expect(ranked[4]).not.toHaveProperty("maintenanceCost");
  });

  /** 10 000 files with distinct commit counts: file i sits at cost position i / 9999. */
  function graded(): FileMaintenanceCostModel {
    const files = new Map<string, GitFileMaintenanceSignals>();
    for (let i = 0; i < 10_000; i++) files.set(`f${i}.ts`, { commitCount: i + 1, bugFixRate: 0, ageDays: 1 });
    return new FileMaintenanceCostModel(files);
  }
  const span = (from: number, count: number) => Array.from({ length: count }, (_, k) => `f${from + k}.ts`);

  it("ranks a 7579-file knot near the centre BELOW a 2-file pair far above it when violations spread", () => {
    const knot = { id: "knot", files: span(1311, 7579) }; // mean position 5100 / 9999 ≈ 0.51
    const pair = { id: "pair", files: ["f9449.ts", "f9549.ts"] }; // mean 9499 / 9999 ≈ 0.95
    const cold = { id: "cold", files: ["f0.ts", "f100.ts"] };
    const hot = { id: "hot", files: ["f9999.ts", "f9900.ts", "f9800.ts"] };

    const ranked = rankByMaintenanceCost([knot, cold, pair, hot], (i) => i.files, graded());

    expect(ranked.map((i) => i.id)).toEqual(["hot", "pair", "knot", "cold"]);
    expect(ranked[2].maintenanceCost?.score).toBeCloseTo(0.51, 2);
  });

  it("orders equal scores by carrier count, then detector order — all 0.5 when the means do not spread", () => {
    // Every mean sits within carrier noise of the centre: no spread is evidenced, every score is 0.5.
    const items = [
      { id: "small", files: ["f5000.ts"] },
      { id: "large", files: span(4000, 2000) },
      { id: "alsoSmall", files: ["f4999.ts"] },
    ];

    const ranked = rankByMaintenanceCost(items, (i) => i.files, graded());

    expect(ranked.map((i) => i.id)).toEqual(["large", "small", "alsoSmall"]);
    expect(ranked.map((i) => i.maintenanceCost?.score)).toEqual([0.5, 0.5, 0.5]);
  });

  it("ranks families over ONE population: n₀ is shared, each family keeps its own list", () => {
    const model = graded();
    const sdp = [
      { id: "sdpCold", files: ["f10.ts"] },
      { id: "sdpHot", files: ["f9990.ts"] },
    ];
    const knots = [{ id: "knot", files: span(1311, 7579) }];

    const [rankedSdp, rankedKnots] = rankFamiliesByMaintenanceCost(
      [maintenanceCostFamily(sdp, (i) => i.files), maintenanceCostFamily(knots, (i) => i.files)],
      model,
    );

    expect(rankedSdp.map((i) => i.id)).toEqual(["sdpHot", "sdpCold"]);
    // Alone, the knot would have no population to spread against and read 0.5;
    // in the report's population it keeps its own mean.
    expect(rankedKnots[0].maintenanceCost?.score).toBeCloseTo(0.51, 2);
    expect(rankByMaintenanceCost(knots, (i) => i.files, model)[0].maintenanceCost?.score).toBe(0.5);
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
