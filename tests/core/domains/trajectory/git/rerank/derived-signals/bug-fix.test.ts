import { describe, expect, it } from "vitest";

import type { SignalConfidence } from "../../../../../../../src/core/contracts/types/trajectory.js";
import { BugFixSignal } from "../../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.js";

/**
 * Regression: numerical equivalence of `bugFix` score across the migration
 * from class-level FALLBACK_THRESHOLD/dampeningSource to descriptor-driven
 * `confidence.score.threshold`. With threshold=10 (constant in both regimes)
 * and the same payload, the dampened score must match.
 */
describe("BugFixSignal — confidence-driven dampening", () => {
  const signal = new BugFixSignal();

  // Helper: build a payload with file+chunk bugFixRate and commitCount values.
  const payload = (bfr: number, cc: number) => ({
    git: {
      file: { bugFixRate: bfr, commitCount: cc },
      chunk: { bugFixRate: bfr, commitCount: cc },
    },
  });

  const confidence: SignalConfidence = {
    support: "commitCount",
    score: { threshold: 10 },
    label: {
      rules: [
        { whenSupportBelow: 5, ceiling: "healthy" },
        { whenSupportBelow: 10, ceiling: "concerning" },
      ],
    },
  };

  it("user trigger case: bugFixRate=63 commitCount=3 → heavily dampened", () => {
    const score = signal.extract(payload(63, 3), {
      bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
      confidence,
    });
    // confidenceDampening(3, 10) = (3/10)^2 = 0.09
    // blendNormalized at chunk level for matching file+chunk: ≈ 0.63
    // expected: 0.63 * 0.09 = 0.0567
    expect(score).toBeCloseTo(0.0567, 3);
  });

  it("medium-N: bugFixRate=63 commitCount=8 → moderately dampened", () => {
    const score = signal.extract(payload(63, 8), {
      bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
      confidence,
    });
    // (8/10)^2 = 0.64; 0.63 * 0.64 ≈ 0.4032
    expect(score).toBeCloseTo(0.4032, 3);
  });

  it("high-N: bugFixRate=63 commitCount=50 → no dampening", () => {
    const score = signal.extract(payload(63, 50), {
      bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
      confidence,
    });
    // min(50/10, 1)^2 = 1; 0.63 * 1 = 0.63
    expect(score).toBeCloseTo(0.63, 3);
  });

  it("custom threshold from confidence overrides default", () => {
    const customConfidence: SignalConfidence = {
      support: "commitCount",
      score: { threshold: 20 },
    };
    const score = signal.extract(payload(50, 10), {
      bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
      confidence: customConfidence,
    });
    // (10/20)^2 = 0.25; blendNormalized ≈ 0.5; 0.5 * 0.25 = 0.125
    expect(score).toBeCloseTo(0.125, 3);
  });

  it("custom support signal name routes through confidence", () => {
    const customConfidence: SignalConfidence = {
      support: "fooCount",
      score: { threshold: 10 },
    };
    const customPayload = {
      git: {
        file: { bugFixRate: 50, fooCount: 5 },
        chunk: { bugFixRate: 50, fooCount: 5 },
      },
    };
    const score = signal.extract(customPayload, {
      bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
      confidence: customConfidence,
    });
    // (5/10)^2 = 0.25; blendNormalized ≈ 0.5; 0.5 * 0.25 = 0.125
    expect(score).toBeCloseTo(0.125, 3);
  });

  it("falls back to FALLBACK_K=10 when ctx has no confidence (legacy path)", () => {
    // Without ctx.confidence and without ctx.dampeningThreshold, k = FALLBACK_K = 10.
    // Same numerical result as the bugFixRate=63 commitCount=3 case above.
    const score = signal.extract(payload(63, 3), {
      bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
    });
    expect(score).toBeCloseTo(0.0567, 3);
  });

  it("uses ctx.dampeningThreshold when confidence not present (adaptive path)", () => {
    // Pre-refactor adaptive path: ctx.dampeningThreshold=20 (e.g. p25 of commitCount=20 in a project).
    const score = signal.extract(payload(50, 10), {
      bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
      dampeningThreshold: 20,
    });
    // (10/20)^2 = 0.25; blendNormalized ≈ 0.5; 0.5 * 0.25 = 0.125
    expect(score).toBeCloseTo(0.125, 3);
  });

  it("ADAPTIVE wins over descriptor floor when both are present (regression for tea-rags-mcp-2h45)", () => {
    // Both adaptive (dampeningThreshold=20 from collection p25) AND descriptor
    // floor (confidence.score.threshold=10) are passed. Adaptive must win.
    // Before the fix: descriptor floor won, ignoring adaptive entirely.
    const score = signal.extract(payload(50, 10), {
      bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
      dampeningThreshold: 20,
      confidence,
    });
    // With adaptive k=20: (10/20)^2 = 0.25; ≈ 0.5 * 0.25 = 0.125
    // With static k=10 (wrong): (10/10)^2 = 1; ≈ 0.5 (would be ~0.5)
    expect(score).toBeCloseTo(0.125, 3);
  });

  it("descriptor floor used when collectionStats absent (no dampeningThreshold)", () => {
    // No collection stats → reranker can't compute adaptive → ctx.dampeningThreshold
    // is undefined. Falls back to descriptor's confidence.score.threshold=10.
    const score = signal.extract(payload(63, 3), {
      bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
      confidence,
    });
    // k=10 (floor): (3/10)^2 = 0.09; blend ≈ 0.63; 0.63 * 0.09 ≈ 0.0567
    expect(score).toBeCloseTo(0.0567, 3);
  });
});
