import { describe, expect, it } from "vitest";

import {
  calibration,
  menuBucket,
  pBucket,
  recallProxy,
  receiverShape,
  scoreLabelledEdges,
  stratifiedSample,
  thresholdSweep,
  type LabelledEdge,
  type SampleCandidate,
} from "../../scripts/lib/residual-sample-core.js";

const labelled = (p: number, correct: boolean, over: Partial<LabelledEdge> = {}): LabelledEdge => ({
  id: `e-${p}-${String(correct)}`,
  stratum: "dynamic|0.9+|2-3|param",
  kind: "dynamic",
  pBucket: "0.9+",
  menuBucket: "2-3",
  receiverShape: "param",
  chosen: "Firm#users",
  p,
  label: correct ? "Firm#users" : "Team#users",
  ...over,
});

describe("strata", () => {
  it("buckets p, menu size and receiver shape", () => {
    expect([0.65, 0.7, 0.85, 0.9, 1].map(pBucket)).toEqual(["<0.7", "0.7-0.8", "0.8-0.9", "0.9+", "0.9+"]);
    expect([1, 2, 3, 4, 10, 11, 40, 41].map(menuBucket)).toEqual([
      "1",
      "2-3",
      "2-3",
      "4-10",
      "4-10",
      "11-40",
      "11-40",
      ">40",
    ]);
    const source = "def run(account, firm:)\n  local = build\n  account.users\nend";
    expect(receiverShape("@account", source)).toBe("ivar");
    expect(receiverShape("account", source)).toBe("param");
    expect(receiverShape("firm", source)).toBe("param");
    expect(receiverShape("local", source)).toBe("local");
    expect(receiverShape("account.firm", source)).toBe("chained");
    expect(receiverShape("find(id)", source)).toBe("chained");
    expect(receiverShape("Firm", source)).toBe("constant");
    expect(receiverShape("self", source)).toBe("self");
    expect(receiverShape("", source)).toBe("implicit");
  });
});

describe("stratifiedSample", () => {
  const candidates = (n: number, stratum: string): SampleCandidate[] =>
    Array.from({ length: n }, (_, i) => ({ id: `${stratum}-${i}`, stratum }));

  it("draws exactly n, every non-empty stratum at least once, the rest in proportion, reproducibly", () => {
    const pool = [...candidates(90, "big"), ...candidates(9, "mid"), ...candidates(1, "rare")];

    const first = stratifiedSample(pool, 20, 7);
    const second = stratifiedSample(pool, 20, 7);

    expect(first).toHaveLength(20);
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
    const per = (s: string): number => first.filter((c) => c.stratum === s).length;
    expect(per("rare")).toBe(1);
    expect(per("mid")).toBeGreaterThanOrEqual(1);
    expect(per("big")).toBeGreaterThan(per("mid"));
    expect(new Set(first.map((c) => c.id)).size).toBe(20);
  });

  it("returns the whole pool when n exceeds it", () => {
    expect(stratifiedSample(candidates(3, "a"), 10, 1)).toHaveLength(3);
  });
});

describe("scoring", () => {
  const edges = [
    labelled(0.95, true),
    labelled(0.95, true),
    labelled(0.85, true, { pBucket: "0.8-0.9", stratum: "dynamic|0.8-0.9|2-3|param" }),
    labelled(0.85, false, { pBucket: "0.8-0.9", stratum: "dynamic|0.8-0.9|2-3|param" }),
    labelled(0.75, false, { pBucket: "0.7-0.8", stratum: "dynamic|0.7-0.8|2-3|param", kind: "ambiguous" }),
  ];

  it("reports precision overall, per stratum and per dimension, skipping unlabelled rows", () => {
    const score = scoreLabelledEdges([...edges, labelled(0.9, true, { label: null })]);

    expect(score.labelled).toBe(5);
    expect(score.precision).toBeCloseTo(3 / 5);
    expect(score.byStratum["dynamic|0.9+|2-3|param"]).toEqual({ n: 2, correct: 2, precision: 1 });
    expect(score.byDimension.pBucket["0.8-0.9"]).toEqual({ n: 2, correct: 1, precision: 0.5 });
    expect(score.byDimension.kind.ambiguous).toEqual({ n: 1, correct: 0, precision: 0 });
  });

  it("bins predicted p into five bins and computes ECE as the count-weighted |accuracy - confidence|", () => {
    const { bins, ece } = calibration(edges);

    expect(bins).toHaveLength(5);
    expect(bins[4]).toMatchObject({ lo: 0.9, hi: 1, n: 2, accuracy: 1, meanP: 0.95 });
    expect(bins[3]).toMatchObject({ n: 2, accuracy: 0.5, meanP: 0.85 });
    expect(bins[2]).toMatchObject({ n: 1, accuracy: 0, meanP: 0.75 });
    // (2·|1-0.95| + 2·|0.5-0.85| + 1·|0-0.75|) / 5
    expect(ece).toBeCloseTo((2 * 0.05 + 2 * 0.35 + 0.75) / 5);
  });

  it("sweeps thresholds 0.5..0.95 with edges kept and precision, and recommends the lowest one reaching the target", () => {
    const sweep = thresholdSweep(edges, 0.93);

    expect(sweep.rows.map((row) => row.threshold)).toEqual([0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]);
    expect(sweep.rows.find((row) => row.threshold === 0.8)).toEqual({
      threshold: 0.8,
      kept: 4,
      keptShare: 0.8,
      precision: 0.75,
    });
    expect(sweep.recommended).toBe(0.9);
  });

  it("measures agreement between the label and a spot-check label where both exist", () => {
    const score = scoreLabelledEdges([
      labelled(0.9, true, { spotLabel: "Firm#users" }),
      labelled(0.9, true, { spotLabel: "Team#users" }),
      labelled(0.9, true),
    ]);

    expect(score.spotCheck).toEqual({ n: 2, agree: 1, agreement: 0.5 });
  });

  it("recall proxy: of oracle sites whose truth is on the menu, the share that got the true edge at the threshold", () => {
    const recall = recallProxy(
      [
        { truth: "A", menu: ["A", "B"], pick: "A", p: 0.9 },
        { truth: "A", menu: ["A", "B"], pick: "A", p: 0.6 },
        { truth: "A", menu: ["A", "B"], pick: "B", p: 0.95 },
        { truth: "A", menu: ["A", "B"], pick: null, p: null },
        { truth: "C", menu: ["A", "B"], pick: "A", p: 0.99 },
      ],
      0.7,
    );

    expect(recall).toEqual({ eligible: 4, recovered: 1, recall: 0.25, wrongEdges: 1 });
  });
});
