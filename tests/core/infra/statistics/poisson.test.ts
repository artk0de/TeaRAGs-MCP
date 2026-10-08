/**
 * Foundation statistics barrel (bd tea-rags-mcp-xb669.8): the co-change pair
 * gate's Poisson upper tail (lifted unchanged from `cochange-significance.ts`,
 * pinned there) and the BH procedure both trajectory sub-domains share.
 */
import { describe, expect, it } from "vitest";

import {
  benjaminiHochbergRejectionCount,
  CONVENTIONAL_FDR_Q,
  poissonUpperTail,
} from "../../../../src/core/infra/statistics/index.js";

describe("statistics barrel", () => {
  it("carries the pair gate's BH procedure and its conventional q", () => {
    expect(CONVENTIONAL_FDR_Q).toBe(0.05);
    expect(benjaminiHochbergRejectionCount([0.001, 0.02, 0.9], 3)).toBe(2);
  });

  it("carries the pair gate's Poisson upper tail", () => {
    expect(poissonUpperTail(1, 3)).toBeCloseTo(1 - Math.exp(-3), 15);
  });
});
