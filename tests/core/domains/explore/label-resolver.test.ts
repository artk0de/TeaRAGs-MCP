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

  /**
   * An atomic distribution ties neighbouring percentiles, and a value sitting on
   * the tie could honestly be read as any band in the run. Which end is right is
   * a property of the SIGNAL, not of the data: 100% dominant-author is a
   * deep-silo whatever else the corpus looks like, while one contributor is
   * `solo` and never `team`. So the descriptor declares it.
   */
  describe("tied bands resolve to the end the descriptor declares", () => {
    const ladder = { p50: "healthy", p75: "concerning", p95: "critical" };
    const allTied = { 50: 25, 75: 25, 95: 25 };

    it("defaults to the upper end, preserving the walk-and-keep-the-last rule", () => {
      expect(resolveLabel(25, ladder, allTied)).toBe("critical");
    });

    it("reports the lower end when the descriptor asks for it", () => {
      expect(resolveLabel(25, ladder, allTied, { bandTieBreak: "lower" })).toBe("healthy");
    });

    it("leaves a value below the whole ladder on the default band either way", () => {
      expect(resolveLabel(3, ladder, allTied, { bandTieBreak: "lower" })).toBe("healthy");
      expect(resolveLabel(3, ladder, allTied, { bandTieBreak: "upper" })).toBe("healthy");
    });

    it("keeps the below-everything default reachable when the tie is at the top of the scale", () => {
      // blameDominantAuthorPct on a single-author repository: four bands, all at
      // 100. 100 IS a deep silo; 99 is not, and must still find a band.
      const silo = { p25: "shared", p50: "concentrated", p75: "silo", p95: "deep-silo" };
      const pinned = { 25: 100, 50: 100, 75: 100, 95: 100 };
      expect(resolveLabel(100, silo, pinned, { bandTieBreak: "upper" })).toBe("deep-silo");
      expect(resolveLabel(99, silo, pinned, { bandTieBreak: "upper" })).toBe("shared");
    });

    it("resolves a count tied at the bottom of its scale to the least-severe name", () => {
      // blameContributorCount: one contributor is `solo`, never `team`.
      const crowding = { p25: "solo", p50: "pair", p75: "team", p95: "crowd" };
      const pinned = { 25: 1, 50: 1, 75: 1, 95: 2 };
      expect(resolveLabel(1, crowding, pinned, { bandTieBreak: "lower" })).toBe("solo");
      expect(resolveLabel(2, crowding, pinned, { bandTieBreak: "lower" })).toBe("crowd");
    });

    it("does not disturb a strictly increasing ladder", () => {
      const percentiles = { 50: 0, 75: 50, 95: 100 };
      for (const tie of ["lower", "upper"] as const) {
        expect(resolveLabel(0, ladder, percentiles, { bandTieBreak: tie })).toBe("healthy");
        expect(resolveLabel(60, ladder, percentiles, { bandTieBreak: tie })).toBe("concerning");
        expect(resolveLabel(100, ladder, percentiles, { bandTieBreak: tie })).toBe("critical");
      }
    });
  });

  /**
   * A floor band's own threshold is inert — it owns everything below the SECOND
   * band — so whether one was computed for it changes nothing about what it
   * covers. Age is the live case (`git/age-derivation.ts`): its bands come from
   * inverting lastModifiedAt percentiles, the stamp declares p5/p25/p50, and
   * age p25 therefore yields no band at all.
   */
  describe("a declared floor band with no computed percentile", () => {
    const age = { p25: "recent", p50: "typical", p75: "old", p95: "legacy" };
    const inverted = { 50: 30, 75: 90, 95: 200 };

    it("is still the default for everything below the next band", () => {
      expect(resolveLabel(5, age, inverted)).toBe("recent");
      expect(resolveLabel(29, age, inverted)).toBe("recent");
    });

    it("gives way as soon as a computed band is reached", () => {
      expect(resolveLabel(30, age, inverted)).toBe("typical");
      expect(resolveLabel(90, age, inverted)).toBe("old");
      expect(resolveLabel(1000, age, inverted)).toBe("legacy");
    });
  });
});
