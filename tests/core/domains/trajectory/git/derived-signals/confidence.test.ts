import { describe, expect, it } from "vitest";

import type { ExtractContext } from "../../../../../../src/core/contracts/types/trajectory.js";
import { BugFixSignal } from "../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.js";
import { DensitySignal } from "../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/density.js";
import { KnowledgeSiloSignal } from "../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/knowledge-silo.js";
import { OwnershipSignal } from "../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/ownership.js";
import { RelativeChurnNormSignal } from "../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/relative-churn-norm.js";
import { VolatilitySignal } from "../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/volatility.js";

function makePayload(fileFields: Record<string, unknown>) {
  return { git: { file: fileFields } };
}

describe("BugFixSignal self-dampening", () => {
  const signal = new BugFixSignal();

  it("returns full value when commitCount >= adaptive threshold", () => {
    const raw = makePayload({ commitCount: 20, bugFixRate: 50 });
    const ctx: ExtractContext = {
      bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
      dampeningThreshold: 8,
    };
    const value = signal.extract(raw, ctx);
    expect(value).toBeCloseTo(0.5); // 50/100, confidence=1.0
  });

  it("dampens value when commitCount < adaptive threshold", () => {
    const raw = makePayload({ commitCount: 2, bugFixRate: 50 });
    const ctx: ExtractContext = {
      bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
    };
    const value = signal.extract(raw, ctx);
    // base = 50/100 = 0.5, confidence = (2/10)^2 = 0.04 (FALLBACK_THRESHOLD=10)
    expect(value).toBeCloseTo(0.5 * 0.04);
  });

  it("uses fallback threshold when no dampeningThreshold", () => {
    const raw = makePayload({ commitCount: 2, bugFixRate: 50 });
    const ctx: ExtractContext = { bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 } };
    const value = signal.extract(raw, ctx);
    // Fallback k=10, confidence = (2/10)^2 = 0.04
    expect(value).toBeCloseTo(0.5 * 0.04);
  });

  it("uses fallback threshold k=10 (not k=8)", () => {
    const raw = makePayload({ commitCount: 4, bugFixRate: 50 });
    const ctx: ExtractContext = { bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 } };
    const value = signal.extract(raw, ctx);
    // base = 50/100 = 0.5, confidence = (4/10)^2 = 0.16 (k=10, not k=8 which would give 0.25)
    expect(value).toBeCloseTo(0.5 * 0.16);
  });

  it("returns 0 when no commits", () => {
    const raw = makePayload({ commitCount: 0, bugFixRate: 50 });
    expect(signal.extract(raw, { bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 } })).toBe(0);
  });
});

describe("OwnershipSignal self-dampening", () => {
  const signal = new OwnershipSignal();

  it("dampens with fallback threshold", () => {
    const raw = makePayload({ commitCount: 2, dominantAuthorPct: 80 });
    const ctx: ExtractContext = {};
    const value = signal.extract(raw, ctx);
    // base = 0.8, confidence = (2/5)^2 = 0.16 (FALLBACK_THRESHOLD=5)
    expect(value).toBeCloseTo(0.8 * 0.16);
  });

  it("returns full value when commitCount >= threshold", () => {
    const raw = makePayload({ commitCount: 10, dominantAuthorPct: 80 });
    const ctx: ExtractContext = {};
    expect(signal.extract(raw, ctx)).toBeCloseTo(0.8);
  });
});

describe("VolatilitySignal self-dampening", () => {
  const signal = new VolatilitySignal();

  it("dampens when commitCount below threshold", () => {
    const raw = makePayload({ commitCount: 3, churnVolatility: 50 });
    const ctx: ExtractContext = {
      bounds: { "file.churnVolatility": 100, "chunk.churnVolatility": 100 },
    };
    const value = signal.extract(raw, ctx);
    // base = 50/100 = 0.5, confidence = (3/8)^2 = 0.140625 (FALLBACK_THRESHOLD=8)
    expect(value).toBeCloseTo(0.5 * 0.140625);
  });
});

describe("KnowledgeSiloSignal self-dampening", () => {
  const signal = new KnowledgeSiloSignal();

  it("dampens when commitCount below threshold", () => {
    const raw = makePayload({ commitCount: 2, contributorCount: 1 });
    const ctx: ExtractContext = {};
    const value = signal.extract(raw, ctx);
    // base = 1.0 (1 contributor), confidence = (2/5)^2 = 0.16 (FALLBACK_THRESHOLD=5)
    expect(value).toBeCloseTo(1.0 * 0.16);
  });
});

describe("DensitySignal self-dampening", () => {
  const signal = new DensitySignal();

  it("dampens when commitCount below threshold", () => {
    const raw = makePayload({ commitCount: 2, changeDensity: 10 });
    const ctx: ExtractContext = {
      bounds: { "file.changeDensity": 20, "chunk.changeDensity": 20 },
    };
    const value = signal.extract(raw, ctx);
    // base = 10/20 = 0.5, confidence = (2/5)^2 = 0.16 (FALLBACK_THRESHOLD=5)
    expect(value).toBeCloseTo(0.5 * 0.16);
  });
});

describe("RelativeChurnNormSignal self-dampening", () => {
  const signal = new RelativeChurnNormSignal();

  it("dampens when commitCount below threshold", () => {
    const raw = makePayload({ commitCount: 2, relativeChurn: 2.5 });
    const ctx: ExtractContext = {
      bounds: { "file.relativeChurn": 5.0, "chunk.relativeChurn": 5.0 },
    };
    const value = signal.extract(raw, ctx);
    // base = 2.5/5.0 = 0.5, confidence = (2/5)^2 = 0.16 (FALLBACK_THRESHOLD=5)
    expect(value).toBeCloseTo(0.5 * 0.16);
  });
});
