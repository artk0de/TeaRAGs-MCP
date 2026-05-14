import { describe, expect, it } from "vitest";

import type { SignalConfidence } from "../../../../src/core/contracts/types/trajectory.js";
import { resolveLabel } from "../../../../src/core/domains/explore/label-resolver.js";

describe("resolveLabel", () => {
  const labels = { p25: "low", p50: "typical", p75: "high", p95: "extreme" };
  const percentiles = { 25: 2, 50: 5, 75: 12, 95: 30 };

  it("should return first label for values below all thresholds", () => {
    expect(resolveLabel(0, labels, percentiles)).toBe("low");
    expect(resolveLabel(1, labels, percentiles)).toBe("low");
  });

  it("should return first label for values in first bucket", () => {
    expect(resolveLabel(2, labels, percentiles)).toBe("low");
    expect(resolveLabel(4, labels, percentiles)).toBe("low");
  });

  it("should return correct bucket label", () => {
    expect(resolveLabel(5, labels, percentiles)).toBe("typical");
    expect(resolveLabel(11, labels, percentiles)).toBe("typical");
    expect(resolveLabel(12, labels, percentiles)).toBe("high");
    expect(resolveLabel(29, labels, percentiles)).toBe("high");
  });

  it("should return last label for values at or above last threshold", () => {
    expect(resolveLabel(30, labels, percentiles)).toBe("extreme");
    expect(resolveLabel(100, labels, percentiles)).toBe("extreme");
  });

  it("should handle two-label signals", () => {
    const twoLabels = { p75: "normal", p95: "high" };
    const twoPercentiles = { 75: 10, 95: 25 };
    expect(resolveLabel(5, twoLabels, twoPercentiles)).toBe("normal");
    expect(resolveLabel(10, twoLabels, twoPercentiles)).toBe("normal");
    expect(resolveLabel(15, twoLabels, twoPercentiles)).toBe("normal");
    expect(resolveLabel(25, twoLabels, twoPercentiles)).toBe("high");
    expect(resolveLabel(50, twoLabels, twoPercentiles)).toBe("high");
  });

  it("should return empty string when labels map is empty", () => {
    expect(resolveLabel(100, {}, { 50: 5 })).toBe("");
  });

  it("should handle collapsed percentiles (identical values)", () => {
    const collapsed = { p25: "low", p50: "typical", p75: "high", p95: "extreme" };
    const sameValues = { 25: 5, 50: 5, 75: 5, 95: 5 };
    // All thresholds are 5, value 3 < 5 → first label
    expect(resolveLabel(3, collapsed, sameValues)).toBe("low");
    // Value 5 >= all thresholds → last label
    expect(resolveLabel(5, collapsed, sameValues)).toBe("extreme");
  });

  describe("confidence clamp (LabelContext)", () => {
    const bugFixLabels = { p50: "healthy", p75: "concerning", p95: "critical" };
    const bugFixPercentiles = { 50: 25, 75: 38, 95: 53 };
    const bugFixConfidence: SignalConfidence = {
      support: "commitCount",
      label: {
        rules: [
          { whenSupportBelow: 5, ceiling: "healthy" },
          { whenSupportBelow: 10, ceiling: "concerning" },
        ],
      },
    };

    it("returns base label when ctx is undefined (backwards compat)", () => {
      expect(resolveLabel(63, bugFixLabels, bugFixPercentiles)).toBe("critical");
    });

    it("returns base label when descriptor has no confidence.label block", () => {
      expect(
        resolveLabel(63, bugFixLabels, bugFixPercentiles, {
          siblingValues: { commitCount: 3 },
          confidence: { support: "commitCount" },
        }),
      ).toBe("critical");
    });

    it("returns base label when siblingValues missing the support signal", () => {
      expect(
        resolveLabel(63, bugFixLabels, bugFixPercentiles, {
          siblingValues: {},
          confidence: bugFixConfidence,
        }),
      ).toBe("critical");
    });

    it("clamps to 'healthy' when support < 5 (user trigger case bugFixRate=63 commitCount=3)", () => {
      expect(
        resolveLabel(63, bugFixLabels, bugFixPercentiles, {
          siblingValues: { commitCount: 3 },
          confidence: bugFixConfidence,
        }),
      ).toBe("healthy");
    });

    it("clamps to 'concerning' when support is 5..9", () => {
      expect(
        resolveLabel(63, bugFixLabels, bugFixPercentiles, {
          siblingValues: { commitCount: 8 },
          confidence: bugFixConfidence,
        }),
      ).toBe("concerning");
    });

    it("no clamp when support >= 10 (label stays critical)", () => {
      expect(
        resolveLabel(63, bugFixLabels, bugFixPercentiles, {
          siblingValues: { commitCount: 50 },
          confidence: bugFixConfidence,
        }),
      ).toBe("critical");
    });

    it("ceiling never raises severity (base 'healthy' stays 'healthy' even when rule fires)", () => {
      // bugFixRate=12 binned as "healthy" (below p50=25). Even if commitCount=3 triggers rule
      // with ceiling "typical", "healthy" is less severe than "typical" → keep "healthy".
      // Note: bugFix labelMap starts at p50 (healthy) — values below get first label.
      const fullLabels = { p25: "ok", p50: "healthy", p75: "concerning", p95: "critical" };
      const fullPercentiles = { 25: 10, 50: 25, 75: 38, 95: 53 };
      const conf: SignalConfidence = {
        support: "commitCount",
        label: { rules: [{ whenSupportBelow: 5, ceiling: "concerning" }] },
      };
      expect(
        resolveLabel(8, fullLabels, fullPercentiles, {
          siblingValues: { commitCount: 3 },
          confidence: conf,
        }),
      ).toBe("ok");
    });

    it("first ascending rule wins (rules sorted internally)", () => {
      // Provide rules in reverse order; resolver must sort by whenSupportBelow
      const conf: SignalConfidence = {
        support: "commitCount",
        label: {
          rules: [
            { whenSupportBelow: 10, ceiling: "concerning" },
            { whenSupportBelow: 5, ceiling: "healthy" },
          ],
        },
      };
      expect(
        resolveLabel(63, bugFixLabels, bugFixPercentiles, {
          siblingValues: { commitCount: 3 },
          confidence: conf,
        }),
      ).toBe("healthy");
    });

    it("throws when ceiling references a label not in labels map", () => {
      const badConf: SignalConfidence = {
        support: "commitCount",
        label: { rules: [{ whenSupportBelow: 5, ceiling: "nonexistent" }] },
      };
      expect(() =>
        resolveLabel(63, bugFixLabels, bugFixPercentiles, {
          siblingValues: { commitCount: 3 },
          confidence: badConf,
        }),
      ).toThrow(/ceiling/i);
    });

    it("generic mechanism — synthetic support signal works identically", () => {
      const synthLabels = { p25: "a", p50: "b", p75: "c" };
      const synthPercentiles = { 25: 1, 50: 5, 75: 10 };
      const synthConf: SignalConfidence = {
        support: "fooCount",
        label: { rules: [{ whenSupportBelow: 3, ceiling: "a" }] },
      };
      // value 12 → base "c"; fooCount=1 < 3 → ceiling "a" → less-severe "a"
      expect(
        resolveLabel(12, synthLabels, synthPercentiles, {
          siblingValues: { fooCount: 1 },
          confidence: synthConf,
        }),
      ).toBe("a");
      // fooCount=5 → no rule matches → base "c" preserved
      expect(
        resolveLabel(12, synthLabels, synthPercentiles, {
          siblingValues: { fooCount: 5 },
          confidence: synthConf,
        }),
      ).toBe("c");
    });
  });
});
