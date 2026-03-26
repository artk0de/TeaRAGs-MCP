import { describe, expect, it } from "vitest";

import type {
  CollectionSignalStats,
  Distributions,
  SignalStats,
  SignalStatsRequest,
} from "../../../src/core/contracts/types/trajectory.js";

describe("SignalStatsRequest", () => {
  it("should accept labels record with pNN keys", () => {
    const req: SignalStatsRequest = {
      labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" },
    };
    expect(req.labels).toBeDefined();
    expect(Object.keys(req.labels!)).toEqual(["p25", "p50", "p75", "p95"]);
  });

  it("should not have percentiles field", () => {
    const req: SignalStatsRequest = { labels: { p50: "normal" } };
    expect(req).not.toHaveProperty("percentiles");
  });

  it("should still accept mean and stddev", () => {
    const req: SignalStatsRequest = {
      labels: { p95: "extreme" },
      mean: true,
      stddev: true,
    };
    expect(req.mean).toBe(true);
    expect(req.stddev).toBe(true);
  });
});

describe("SignalStats", () => {
  it("should require min, max, percentiles", () => {
    const stats: SignalStats = {
      count: 100,
      min: 1,
      max: 50,
      percentiles: { 25: 3, 50: 8, 75: 15, 95: 42 },
    };
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(50);
    expect(stats.percentiles[95]).toBe(42);
  });
});

describe("Distributions", () => {
  it("should have all required fields", () => {
    const dist: Distributions = {
      totalFiles: 100,
      language: { typescript: 80, python: 20 },
      chunkType: { function: 60, class: 30, block: 10 },
      documentation: { docs: 15, code: 85 },
      topAuthors: [{ name: "Alice", chunks: 50 }],
      othersCount: 50,
    };
    expect(dist.totalFiles).toBe(100);
    expect(dist.topAuthors[0].name).toBe("Alice");
  });
});

describe("CollectionSignalStats", () => {
  it("should include distributions", () => {
    const stats: CollectionSignalStats = {
      perSignal: new Map(),
      perLanguage: new Map(),
      distributions: {
        totalFiles: 0,
        language: {},
        chunkType: {},
        documentation: { docs: 0, code: 0 },
        topAuthors: [],
        othersCount: 0,
      },
      computedAt: Date.now(),
    };
    expect(stats.distributions).toBeDefined();
    expect(stats.distributions.totalFiles).toBe(0);
  });
});
