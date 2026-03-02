import { describe, expect, it } from "vitest";

import { computeCollectionStats } from "../../../src/core/contracts/collection-stats.js";
import type { PayloadSignalDescriptor } from "../../../src/core/contracts/types/trajectory.js";

describe("computeCollectionStats", () => {
  const signals: PayloadSignalDescriptor[] = [
    { key: "git.file.commitCount", type: "number", description: "commits" },
    { key: "git.file.ageDays", type: "number", description: "age" },
    { key: "relativePath", type: "string", description: "path" }, // non-numeric, should be skipped
  ];

  it("computes percentile stats for numeric signals", () => {
    const points = [
      { payload: { git: { file: { commitCount: 10, ageDays: 50 } } } },
      { payload: { git: { file: { commitCount: 20, ageDays: 100 } } } },
      { payload: { git: { file: { commitCount: 30, ageDays: 150 } } } },
      { payload: { git: { file: { commitCount: 40, ageDays: 200 } } } },
      { payload: { git: { file: { commitCount: 50, ageDays: 250 } } } },
    ];
    const stats = computeCollectionStats(points, signals);

    expect(stats.perSignal.has("git.file.commitCount")).toBe(true);
    expect(stats.perSignal.has("git.file.ageDays")).toBe(true);
    expect(stats.perSignal.has("relativePath")).toBe(false); // string, skipped
    expect(stats.computedAt).toBeGreaterThan(0);
  });

  it("computes correct percentile values", () => {
    // 100 values: 1, 2, 3, ..., 100
    const points = Array.from({ length: 100 }, (_, i) => ({
      payload: { git: { file: { commitCount: i + 1 } } },
    }));
    const numericSignals: PayloadSignalDescriptor[] = [
      { key: "git.file.commitCount", type: "number", description: "commits" },
    ];
    const stats = computeCollectionStats(points, numericSignals);
    const s = stats.perSignal.get("git.file.commitCount")!;

    expect(s.count).toBe(100);
    expect(s.p25).toBeCloseTo(25.75, 1);
    expect(s.p50).toBeCloseTo(50.5, 1);
    expect(s.p75).toBeCloseTo(75.25, 1);
    expect(s.p95).toBeCloseTo(95.05, 1);
  });

  it("handles empty payload gracefully", () => {
    const points = [{ payload: {} }, { payload: { git: { file: { commitCount: 10 } } } }];
    const numericSignals: PayloadSignalDescriptor[] = [
      { key: "git.file.commitCount", type: "number", description: "commits" },
    ];
    const stats = computeCollectionStats(points, numericSignals);
    const s = stats.perSignal.get("git.file.commitCount")!;
    expect(s.count).toBe(1); // Only 1 valid value
  });

  it("returns empty map for empty points array", () => {
    const stats = computeCollectionStats([], signals);
    expect(stats.perSignal.size).toBe(0);
    expect(stats.computedAt).toBeGreaterThan(0);
  });
});
