import { describe, expect, it } from "vitest";

import type { PayloadSignalDescriptor } from "../../../src/core/contracts/types/trajectory.js";
import { computeCollectionStats } from "../../../src/core/domains/ingest/collection-stats.js";

describe("computeCollectionStats", () => {
  // 100 values: 1, 2, 3, ..., 100
  const hundredPoints = Array.from({ length: 100 }, (_, i) => ({
    payload: { git: { file: { commitCount: i + 1, ageDays: (i + 1) * 2 } } },
  }));

  it("only computes stats for signals with stats declaration", () => {
    const signals: PayloadSignalDescriptor[] = [
      { key: "git.file.commitCount", type: "number", description: "commits", stats: { percentiles: [25, 95] } },
      { key: "git.file.ageDays", type: "number", description: "age" }, // no stats → skipped
      { key: "relativePath", type: "string", description: "path" }, // non-numeric → skipped
    ];
    const stats = computeCollectionStats(hundredPoints, signals);

    expect(stats.perSignal.has("git.file.commitCount")).toBe(true);
    expect(stats.perSignal.has("git.file.ageDays")).toBe(false); // no stats field
    expect(stats.perSignal.has("relativePath")).toBe(false);
    expect(stats.computedAt).toBeGreaterThan(0);
  });

  it("computes requested percentiles as Record<number, number>", () => {
    const signals: PayloadSignalDescriptor[] = [
      { key: "git.file.commitCount", type: "number", description: "commits", stats: { percentiles: [25, 50, 75, 95] } },
    ];
    const stats = computeCollectionStats(hundredPoints, signals);
    const s = stats.perSignal.get("git.file.commitCount")!;

    expect(s.count).toBe(100);
    expect(s.percentiles).toBeDefined();
    expect(s.percentiles![25]).toBeCloseTo(25.75, 1);
    expect(s.percentiles![50]).toBeCloseTo(50.5, 1);
    expect(s.percentiles![75]).toBeCloseTo(75.25, 1);
    expect(s.percentiles![95]).toBeCloseTo(95.05, 1);
  });

  it("computes only requested percentiles (subset)", () => {
    const signals: PayloadSignalDescriptor[] = [
      { key: "git.file.commitCount", type: "number", description: "commits", stats: { percentiles: [95] } },
    ];
    const stats = computeCollectionStats(hundredPoints, signals);
    const s = stats.perSignal.get("git.file.commitCount")!;

    expect(s.percentiles).toBeDefined();
    expect(s.percentiles![95]).toBeCloseTo(95.05, 1);
    expect(s.percentiles![25]).toBeUndefined(); // not requested
  });

  it("computes mean when requested", () => {
    const signals: PayloadSignalDescriptor[] = [
      { key: "git.file.commitCount", type: "number", description: "commits", stats: { mean: true } },
    ];
    const stats = computeCollectionStats(hundredPoints, signals);
    const s = stats.perSignal.get("git.file.commitCount")!;

    expect(s.mean).toBeCloseTo(50.5, 1); // mean of 1..100
    expect(s.percentiles).toBeUndefined(); // not requested
  });

  it("computes stddev when requested", () => {
    const signals: PayloadSignalDescriptor[] = [
      { key: "git.file.commitCount", type: "number", description: "commits", stats: { stddev: true } },
    ];
    const stats = computeCollectionStats(hundredPoints, signals);
    const s = stats.perSignal.get("git.file.commitCount")!;

    // stddev of 1..100 ≈ 28.87 (population stddev)
    expect(s.stddev).toBeCloseTo(28.87, 0);
  });

  it("computes all stats types together", () => {
    const signals: PayloadSignalDescriptor[] = [
      {
        key: "git.file.commitCount",
        type: "number",
        description: "commits",
        stats: { percentiles: [25, 50, 75, 95], mean: true, stddev: true },
      },
    ];
    const stats = computeCollectionStats(hundredPoints, signals);
    const s = stats.perSignal.get("git.file.commitCount")!;

    expect(s.count).toBe(100);
    expect(s.percentiles![25]).toBeCloseTo(25.75, 1);
    expect(s.mean).toBeCloseTo(50.5, 1);
    expect(s.stddev).toBeCloseTo(28.87, 0);
  });

  it("handles empty payload gracefully", () => {
    const points = [{ payload: {} }, { payload: { git: { file: { commitCount: 10 } } } }];
    const signals: PayloadSignalDescriptor[] = [
      { key: "git.file.commitCount", type: "number", description: "commits", stats: { percentiles: [50] } },
    ];
    const stats = computeCollectionStats(points, signals);
    const s = stats.perSignal.get("git.file.commitCount")!;
    expect(s.count).toBe(1);
  });

  it("returns empty map for empty points array", () => {
    const signals: PayloadSignalDescriptor[] = [
      { key: "git.file.commitCount", type: "number", description: "commits", stats: { percentiles: [50] } },
    ];
    const stats = computeCollectionStats([], signals);
    expect(stats.perSignal.size).toBe(0);
    expect(stats.computedAt).toBeGreaterThan(0);
  });

  it("skips signals without stats even if numeric", () => {
    const signals: PayloadSignalDescriptor[] = [
      { key: "git.file.commitCount", type: "number", description: "commits" }, // no stats
    ];
    const stats = computeCollectionStats(hundredPoints, signals);
    expect(stats.perSignal.size).toBe(0);
  });
});
