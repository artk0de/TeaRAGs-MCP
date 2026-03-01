import { describe, expect, it } from "vitest";

import type {
  CollectionSignalStats,
  ExtractContext,
  PayloadSignalDescriptor,
  SignalStats,
} from "../../../../src/core/contracts/types/trajectory.js";

describe("PayloadSignalDescriptor", () => {
  it("represents a raw payload field descriptor", () => {
    const signal: PayloadSignalDescriptor = {
      key: "git.file.commitCount",
      type: "number",
      description: "Total commits modifying this file",
    };
    expect(signal.key).toBe("git.file.commitCount");
    expect(signal.type).toBe("number");
    expect(signal.description).toBeTruthy();
  });
});

describe("SignalStats", () => {
  it("holds percentile distribution", () => {
    const stats: SignalStats = { p25: 3, p50: 8, p75: 20, p95: 50, count: 100 };
    expect(stats.p25).toBeLessThan(stats.p50);
    expect(stats.count).toBeGreaterThan(0);
  });
});

describe("CollectionSignalStats", () => {
  it("holds per-signal stats with timestamp", () => {
    const stats: CollectionSignalStats = {
      perSignal: new Map([["git.file.commitCount", { p25: 3, p50: 8, p75: 20, p95: 50, count: 100 }]]),
      computedAt: Date.now(),
    };
    expect(stats.perSignal.get("git.file.commitCount")?.p50).toBe(8);
    expect(stats.computedAt).toBeGreaterThan(0);
  });
});

describe("ExtractContext", () => {
  it("combines bound and collectionStats", () => {
    const ctx: ExtractContext = {
      bound: 365,
      collectionStats: {
        perSignal: new Map(),
        computedAt: Date.now(),
      },
    };
    expect(ctx.bound).toBe(365);
    expect(ctx.collectionStats).toBeDefined();
  });

  it("allows partial context (bound only)", () => {
    const ctx: ExtractContext = { bound: 50 };
    expect(ctx.collectionStats).toBeUndefined();
  });

  it("allows empty context", () => {
    const ctx: ExtractContext = {};
    expect(ctx.bound).toBeUndefined();
  });
});
