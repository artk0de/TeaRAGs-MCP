import { describe, expect, it } from "vitest";

import type { CollectionSignalStats, ExtractContext } from "../../../../../src/core/contracts/types/trajectory.js";
import { BugFixSignal } from "../../../../../src/core/trajectory/git/rerank/derived-signals/bug-fix.js";
import { DensitySignal } from "../../../../../src/core/trajectory/git/rerank/derived-signals/density.js";
import { KnowledgeSiloSignal } from "../../../../../src/core/trajectory/git/rerank/derived-signals/knowledge-silo.js";
import { OwnershipSignal } from "../../../../../src/core/trajectory/git/rerank/derived-signals/ownership.js";
import { RelativeChurnNormSignal } from "../../../../../src/core/trajectory/git/rerank/derived-signals/relative-churn-norm.js";
import { VolatilitySignal } from "../../../../../src/core/trajectory/git/rerank/derived-signals/volatility.js";

function makePayload(fileFields: Record<string, unknown>) {
  return { git: { file: fileFields } };
}

function makeStats(key: string, p25: number): CollectionSignalStats {
  return {
    perSignal: new Map([[key, { p25, p50: p25 * 2, p75: p25 * 4, p95: p25 * 8, count: 100 }]]),
    computedAt: Date.now(),
  };
}

describe("BugFixSignal self-dampening", () => {
  const signal = new BugFixSignal();

  it("returns full value when commitCount >= adaptive threshold", () => {
    const raw = makePayload({ commitCount: 20, bugFixRate: 50 });
    const ctx: ExtractContext = {
      bound: 100,
      collectionStats: makeStats("git.file.commitCount", 8),
    };
    const value = signal.extract(raw, ctx);
    expect(value).toBeCloseTo(0.5); // 50/100, confidence=1.0
  });

  it("dampens value when commitCount < adaptive threshold", () => {
    const raw = makePayload({ commitCount: 2, bugFixRate: 50 });
    const ctx: ExtractContext = {
      bound: 100,
      collectionStats: makeStats("git.file.commitCount", 8),
    };
    const value = signal.extract(raw, ctx);
    // base = 50/100 = 0.5, confidence = (2/8)^2 = 0.0625
    expect(value).toBeCloseTo(0.5 * 0.0625);
  });

  it("uses fallback threshold when no stats available", () => {
    const raw = makePayload({ commitCount: 2, bugFixRate: 50 });
    const ctx: ExtractContext = { bound: 100 };
    const value = signal.extract(raw, ctx);
    // Fallback k=8, confidence = (2/8)^2 = 0.0625
    expect(value).toBeCloseTo(0.5 * 0.0625);
  });

  it("returns 0 when no commits", () => {
    const raw = makePayload({ commitCount: 0, bugFixRate: 50 });
    expect(signal.extract(raw, { bound: 100 })).toBe(0);
  });
});

describe("OwnershipSignal self-dampening", () => {
  const signal = new OwnershipSignal();

  it("dampens with adaptive threshold from stats", () => {
    const raw = makePayload({ commitCount: 2, dominantAuthorPct: 80 });
    const ctx: ExtractContext = {
      collectionStats: makeStats("git.file.commitCount", 5),
    };
    const value = signal.extract(raw, ctx);
    // base = 0.8, confidence = (2/5)^2 = 0.16
    expect(value).toBeCloseTo(0.8 * 0.16);
  });

  it("returns full value when commitCount >= threshold", () => {
    const raw = makePayload({ commitCount: 10, dominantAuthorPct: 80 });
    const ctx: ExtractContext = {
      collectionStats: makeStats("git.file.commitCount", 5),
    };
    expect(signal.extract(raw, ctx)).toBeCloseTo(0.8);
  });
});

describe("VolatilitySignal self-dampening", () => {
  const signal = new VolatilitySignal();

  it("dampens when commitCount below threshold", () => {
    const raw = makePayload({ commitCount: 3, churnVolatility: 30 });
    const ctx: ExtractContext = {
      bound: 60,
      collectionStats: makeStats("git.file.commitCount", 8),
    };
    const value = signal.extract(raw, ctx);
    // base = 30/60 = 0.5, confidence = (3/8)^2 = 0.140625
    expect(value).toBeCloseTo(0.5 * 0.140625);
  });
});

describe("KnowledgeSiloSignal self-dampening", () => {
  const signal = new KnowledgeSiloSignal();

  it("dampens when commitCount below threshold", () => {
    const raw = makePayload({ commitCount: 2, contributorCount: 1 });
    const ctx: ExtractContext = {
      collectionStats: makeStats("git.file.commitCount", 5),
    };
    const value = signal.extract(raw, ctx);
    // base = 1.0 (1 contributor), confidence = (2/5)^2 = 0.16
    expect(value).toBeCloseTo(1.0 * 0.16);
  });
});

describe("DensitySignal self-dampening", () => {
  const signal = new DensitySignal();

  it("dampens when commitCount below threshold", () => {
    const raw = makePayload({ commitCount: 2, changeDensity: 10 });
    const ctx: ExtractContext = {
      bound: 20,
      collectionStats: makeStats("git.file.commitCount", 5),
    };
    const value = signal.extract(raw, ctx);
    // base = 10/20 = 0.5, confidence = (2/5)^2 = 0.16
    expect(value).toBeCloseTo(0.5 * 0.16);
  });
});

describe("RelativeChurnNormSignal self-dampening", () => {
  const signal = new RelativeChurnNormSignal();

  it("dampens when commitCount below threshold", () => {
    const raw = makePayload({ commitCount: 2, relativeChurn: 2.5 });
    const ctx: ExtractContext = {
      bound: 5.0,
      collectionStats: makeStats("git.file.commitCount", 5),
    };
    const value = signal.extract(raw, ctx);
    // base = 2.5/5.0 = 0.5, confidence = (2/5)^2 = 0.16
    expect(value).toBeCloseTo(0.5 * 0.16);
  });
});
