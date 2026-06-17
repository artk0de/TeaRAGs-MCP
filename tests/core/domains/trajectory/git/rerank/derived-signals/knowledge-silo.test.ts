import { describe, expect, it } from "vitest";

import type { ExtractContext } from "../../../../../../../src/core/contracts/types/trajectory.js";
import { KnowledgeSiloSignal } from "../../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/knowledge-silo.js";

// alpha = min(1, (chunkCC/fileCC) * min(1, chunkCC/3)).
// chunkCC=5, fileCC=10 → coverage 0.5 × maturity 1 → alpha 0.5.
// Both commitCounts >= FALLBACK_K(5) so per-scope dampening is 1 on each side —
// these cases isolate the piecewise siloScore blend (scope-aware dampening is
// covered separately in confidence.test.ts). Scope-aware blend value =
// alpha*siloScore(chunkCount) + (1-alpha)*siloScore(fileCount), which equals
// siloScore(blend) here because both damps are 1.
function payload(file: Record<string, unknown>, chunk?: Record<string, unknown>) {
  return { git: { file, ...(chunk ? { chunk } : {}) } };
}

describe("KnowledgeSiloSignal — piecewise-linear over blended contributor count", () => {
  const signal = new KnowledgeSiloSignal();
  const ctx: ExtractContext = {};

  it("mixed file=2 chunk=1 blend (a non-integer) lands in the 0.5–1.0 silo band (was 0)", () => {
    const raw = payload({ commitCount: 10, blameContributorCount: 2 }, { commitCount: 5, blameContributorCount: 1 });
    const value = signal.extract(raw, ctx);
    // blend = 0.5*1 + 0.5*2 = 1.5 → siloScore 0.75, dampening 1
    expect(value).toBeGreaterThan(0.5);
    expect(value).toBeLessThan(1.0);
  });

  it("regression: integer 1 contributor → 1.0", () => {
    const raw = payload({ commitCount: 10, blameContributorCount: 1 }, { commitCount: 5, blameContributorCount: 1 });
    expect(signal.extract(raw, ctx)).toBeCloseTo(1.0, 6);
  });

  it("regression: integer 3 contributors → 0", () => {
    const raw = payload({ commitCount: 10, blameContributorCount: 3 }, { commitCount: 5, blameContributorCount: 3 });
    expect(signal.extract(raw, ctx)).toBe(0);
  });

  it("file-only (alpha=0) integer 1 → 1.0", () => {
    const raw = payload({ commitCount: 10, blameContributorCount: 1 });
    expect(signal.extract(raw, ctx)).toBeCloseTo(1.0, 6);
  });

  it("interpolation contract: blended 2.5 → 0.25", () => {
    const raw = payload({ commitCount: 10, blameContributorCount: 3 }, { commitCount: 5, blameContributorCount: 2 });
    // blend = 0.5*2 + 0.5*3 = 2.5 → siloScore 0.25, dampening 1
    expect(signal.extract(raw, ctx)).toBeCloseTo(0.25, 6);
  });

  it("returns 0 when no contributor data", () => {
    expect(signal.extract(payload({ commitCount: 10 }), ctx)).toBe(0);
  });
});
