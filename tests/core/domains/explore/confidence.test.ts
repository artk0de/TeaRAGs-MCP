import { describe, expect, it } from "vitest";

import type { ScoreBackground } from "../../../../src/core/contracts/types/trajectory.js";
import { computeSearchConfidence } from "../../../../src/core/domains/explore/confidence.js";

/**
 * Confidence reads the MAGNITUDE of a result set against the collection's own
 * similarity scale, plus how tightly the hits cluster in the tree. Round 1 of
 * this feature measured the alternative — distribution shape (leader peak,
 * coefficient of variation) — at AUC 0.517 / 0.518, i.e. coin flips, and it was
 * removed. See the design spec before reintroducing anything shape-based.
 */

/** Stand-in for a real collection: background similarity 0.25 ± 0.15. */
const BACKGROUND: ScoreBackground = { mean: 0.25, stddev: 0.15, sampleCount: 600 };

/** A real find on that collection: mean score ≈ 0.63 → z ≈ 2.5, clustered. */
const FIND = [
  { score: 0.82, relativePath: "src/core/domains/explore/reranker.ts" },
  { score: 0.65, relativePath: "src/core/domains/explore/post-process.ts" },
  { score: 0.62, relativePath: "src/core/domains/explore/label-resolver.ts" },
  { score: 0.58, relativePath: "src/core/domains/explore/reranker.ts" },
  { score: 0.55, relativePath: "src/core/domains/explore/signal-floors.ts" },
];

/** Nonsense on the same collection: mean ≈ 0.46 → z ≈ 1.4, scattered. */
const NOISE = [
  { score: 0.473, relativePath: "src/core/adapters/qdrant/client.ts" },
  { score: 0.466, relativePath: "src/cli/commands/doctor.ts" },
  { score: 0.462, relativePath: "src/mcp/tools/explore.ts" },
  { score: 0.458, relativePath: "website/docs/api/tools.md" },
  { score: 0.451, relativePath: "src/core/infra/errors.ts" },
];

describe("computeSearchConfidence", () => {
  describe("magnitude against the collection scale", () => {
    it("separates a result set that scores far above background from one that barely clears it", () => {
      const find = computeSearchConfidence(FIND, BACKGROUND);
      const noise = computeSearchConfidence(NOISE, BACKGROUND);

      expect(find!.value).toBeGreaterThan(noise!.value);
      expect(noise!.label).toBe("low");
      expect(find!.label).not.toBe("low");
    });

    it("reads the same scores differently on a collection whose background is higher", () => {
      // Identical result set, denser collection: the same 0.63 mean is now
      // ordinary, so confidence must drop. This is the whole point of
      // normalising against the collection instead of against a constant.
      const denseCollection: ScoreBackground = { mean: 0.62, stddev: 0.15, sampleCount: 600 };

      expect(computeSearchConfidence(FIND, denseCollection)!.value).toBeLessThan(
        computeSearchConfidence(FIND, BACKGROUND)!.value,
      );
    });

    it("is invariant to a change of embedding scale — background and scores move together", () => {
      // A model that emits similarities at half the magnitude produces the same
      // z-score, therefore the same confidence.
      const halvedScores = FIND.map((r) => ({ ...r, score: r.score / 2 }));
      const halvedBackground: ScoreBackground = { mean: 0.125, stddev: 0.075, sampleCount: 600 };

      expect(computeSearchConfidence(halvedScores, halvedBackground)!.value).toBeCloseTo(
        computeSearchConfidence(FIND, BACKGROUND)!.value,
        6,
      );
    });

    it("saturates rather than overflowing when a result set sits far above background", () => {
      const perfect = FIND.map((r) => ({ ...r, score: 0.99 }));
      const { value } = computeSearchConfidence(perfect, BACKGROUND)!;

      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeGreaterThan(0.9);
    });

    it("floors at zero for a result set at or below background", () => {
      const atBackground = FIND.map((r) => ({ ...r, score: 0.2, relativePath: "a/x.ts" }));
      expect(computeSearchConfidence(atBackground, BACKGROUND)!.value).toBeLessThan(0.4);
    });
  });

  describe("locality — directory entropy", () => {
    it("lifts a clustered response above the same scores scattered across the tree", () => {
      const scattered = FIND.map((r, i) => ({ ...r, relativePath: `src/pkg${i}/file.ts` }));

      expect(computeSearchConfidence(FIND, BACKGROUND)!.value).toBeGreaterThan(
        computeSearchConfidence(scattered, BACKGROUND)!.value,
      );
    });

    it("refines but does not decide — magnitude alone outranks locality alone", () => {
      const strongButScattered = FIND.map((r, i) => ({ ...r, score: 0.95, relativePath: `src/pkg${i}/f.ts` }));
      const weakButClustered = NOISE.map((r) => ({ ...r, score: 0.3, relativePath: "src/one/f.ts" }));

      expect(computeSearchConfidence(strongButScattered, BACKGROUND)!.value).toBeGreaterThan(
        computeSearchConfidence(weakButClustered, BACKGROUND)!.value,
      );
    });

    it("treats results without a path as unlocalizable rather than clustered", () => {
      const noPaths = NOISE.map(({ score }) => ({ score }));
      expect(computeSearchConfidence(noPaths, BACKGROUND)!.value).toBeCloseTo(
        computeSearchConfidence(NOISE, BACKGROUND)!.value,
        6,
      );
    });
  });

  describe("background availability", () => {
    it("reports nothing at all when the collection scale is unknown", () => {
      // An index built before the background existed. Guessing here would put a
      // number on an unmeasured quantity, so the field is simply absent.
      expect(computeSearchConfidence(FIND, undefined)).toBeUndefined();
    });

    it("reports nothing when the background carries no dispersion to divide by", () => {
      expect(computeSearchConfidence(FIND, { mean: 0.25, stddev: 0, sampleCount: 600 })).toBeUndefined();
    });

    it("reports nothing when the background was measured on too few pairs", () => {
      expect(computeSearchConfidence(FIND, { mean: 0.25, stddev: 0.15, sampleCount: 3 })).toBeUndefined();
    });
  });

  describe("degenerate inputs", () => {
    it("reports low confidence for an empty result set, background or not", () => {
      expect(computeSearchConfidence([], BACKGROUND)).toEqual({ value: 0, label: "low" });
      expect(computeSearchConfidence([], undefined)).toEqual({ value: 0, label: "low" });
    });

    it("scores a single result on its own magnitude", () => {
      const { value, label } = computeSearchConfidence([{ score: 0.9, relativePath: "src/a/x.ts" }], BACKGROUND)!;

      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(["low", "medium", "high"]).toContain(label);
    });

    it("survives negative similarities without producing NaN", () => {
      const { value, label } = computeSearchConfidence(
        [
          { score: 0, relativePath: "src/a/x.ts" },
          { score: -0.1, relativePath: "src/b/y.ts" },
          { score: -0.2, relativePath: "src/c/z.ts" },
        ],
        BACKGROUND,
      )!;

      expect(Number.isFinite(value)).toBe(true);
      expect(label).toBe("low");
    });
  });

  describe("output contract", () => {
    it("returns a two-decimal value and one of the three labels", () => {
      const { value, label } = computeSearchConfidence(FIND, BACKGROUND)!;

      expect(value).toBe(Math.round(value * 100) / 100);
      expect(["low", "medium", "high"]).toContain(label);
    });

    it("never leaves [0,1] regardless of input", () => {
      const wild = [
        { score: 12, relativePath: "src/a/x.ts" },
        { score: -3, relativePath: "src/a/y.ts" },
        { score: 0.0005, relativePath: "src/a/z.ts" },
      ];
      const { value } = computeSearchConfidence(wild, BACKGROUND)!;

      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    });
  });

  describe("calibration seam", () => {
    it("a lower z ceiling makes the same result set read stronger", () => {
      const sensitive = computeSearchConfidence(FIND, BACKGROUND, { zCeiling: 2 });
      const dull = computeSearchConfidence(FIND, BACKGROUND, { zCeiling: 8 });

      expect(sensitive!.value).toBeGreaterThan(dull!.value);
    });

    it("defaults to the shipped bounds when no override is given", () => {
      expect(computeSearchConfidence(FIND, BACKGROUND, {})!.value).toBe(
        computeSearchConfidence(FIND, BACKGROUND)!.value,
      );
    });
  });
});
