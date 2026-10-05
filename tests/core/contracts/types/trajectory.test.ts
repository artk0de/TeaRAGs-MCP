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
    const stats: SignalStats = { count: 100, min: 0, max: 100, percentiles: { 25: 3, 50: 8, 75: 20, 95: 50 } };
    expect(stats.percentiles[25]).toBeLessThan(stats.percentiles[50]);
    expect(stats.count).toBeGreaterThan(0);
  });
});

describe("CollectionSignalStats", () => {
  it("holds per-signal stats with timestamp", () => {
    const stats: CollectionSignalStats = {
      perSignal: new Map([
        ["git.file.commitCount", { count: 100, min: 0, max: 100, percentiles: { 25: 3, 50: 8, 75: 20, 95: 50 } }],
      ]),
      perLanguage: new Map(),
      distributions: {
        totalFiles: 0,
        language: {},
        chunkType: {},
        documentation: { docs: 0, code: 0 },
        topAuthors: [],
        topBlameAuthors: [],
        othersCount: 0,
      },
      computedAt: Date.now(),
    };
    expect(stats.perSignal.get("git.file.commitCount")?.percentiles[50]).toBe(8);
    expect(stats.computedAt).toBeGreaterThan(0);
  });
});

describe("ExtractContext", () => {
  it("combines bound and collectionStats", () => {
    const ctx: ExtractContext = {
      bound: 365,
      collectionStats: {
        perSignal: new Map(),
        perLanguage: new Map(),
        distributions: {
          totalFiles: 0,
          language: {},
          chunkType: {},
          documentation: { docs: 0, code: 0 },
          topAuthors: [],
          topBlameAuthors: [],
          othersCount: 0,
        },
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
