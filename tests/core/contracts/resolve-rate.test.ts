import { describe, expect, it } from "vitest";

import {
  EMPTY_RESOLVE_DENOMINATOR_MARKER,
  formatResolveRateCell,
  resolveRateMiss,
} from "../../../src/core/contracts/resolve-rate.js";

/**
 * bd tea-rags-mcp-qodqg — a rate over an empty denominator is "nothing to
 * score", not a perfect (1.000) or failed (0.000) score. Every renderer of the
 * resolve rate goes through one cell formatter so the rule is written once.
 */
describe("formatResolveRateCell", () => {
  const fixed3 = (rate: number): string => rate.toFixed(3);

  it("renders the non-numeric marker and keeps the counters when the denominator is empty", () => {
    expect(formatResolveRateCell({ rate: Number.NaN, denominator: 0, counters: "0/0", renderRate: fixed3 })).toBe(
      "—  0/0",
    );
    expect(EMPTY_RESOLVE_DENOMINATOR_MARKER).toBe("—");
  });

  it("never renders a number for an empty denominator, whatever rate it is handed", () => {
    for (const rate of [0, 1, Number.NaN]) {
      expect(formatResolveRateCell({ rate, denominator: 0, counters: "0/6", renderRate: fixed3 })).toBe("—  0/6");
    }
  });

  it("renders the rate through the caller's formatter when anything was scored", () => {
    expect(formatResolveRateCell({ rate: 0, denominator: 3, counters: "0/3", renderRate: fixed3 })).toBe("0.000 0/3");
    expect(formatResolveRateCell({ rate: 1, denominator: 4, counters: "4/4", renderRate: fixed3 })).toBe("1.000 4/4");
  });
});

describe("resolveRateMiss", () => {
  it("subtracts every bucket that can never become an in-project edge", () => {
    expect(
      resolveRateMiss({
        attempted: 20,
        resolved: 5,
        externalSkipped: 2,
        unresolvable: 3,
        noInProjectDef: 4,
        coreAmbiguous: 1,
      }),
    ).toBe(5);
  });

  it("is zero when every attempted site was excluded — the empty-denominator case", () => {
    expect(
      resolveRateMiss({
        attempted: 6,
        resolved: 0,
        externalSkipped: 0,
        unresolvable: 0,
        noInProjectDef: 6,
        coreAmbiguous: 0,
      }),
    ).toBe(0);
  });

  it("never goes negative on inconsistent counts", () => {
    expect(
      resolveRateMiss({
        attempted: 1,
        resolved: 1,
        externalSkipped: 1,
        unresolvable: 0,
        noInProjectDef: 0,
        coreAmbiguous: 0,
      }),
    ).toBe(0);
  });
});
