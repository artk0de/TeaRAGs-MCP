import { describe, expect, it } from "vitest";

import type { SignalStatsRequest } from "../../../src/core/contracts/types/trajectory.js";

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
