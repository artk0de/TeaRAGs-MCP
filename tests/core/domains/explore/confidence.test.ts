import { describe, expect, it } from "vitest";

import { computeSearchConfidence } from "../../../../src/core/domains/explore/confidence.js";

/**
 * Shape fixtures. Every assertion below is about the SHAPE of the score
 * distribution — never about the absolute magnitude of any score, which is a
 * property of the embedding model and must not leak into the mechanism.
 */

/** A real find: one clear leader, decaying tail, results clustered in one directory. */
const FIND = [
  { score: 0.82, relativePath: "src/core/domains/explore/reranker.ts" },
  { score: 0.54, relativePath: "src/core/domains/explore/post-process.ts" },
  { score: 0.51, relativePath: "src/core/domains/explore/label-resolver.ts" },
  { score: 0.49, relativePath: "src/core/domains/explore/reranker.ts" },
  { score: 0.47, relativePath: "src/core/domains/explore/signal-floors.ts" },
];

/** Nonsense: flat plateau of near-identical scores scattered across the tree. */
const NOISE = [
  { score: 0.553, relativePath: "src/core/adapters/qdrant/client.ts" },
  { score: 0.551, relativePath: "src/cli/commands/doctor.ts" },
  { score: 0.55, relativePath: "src/mcp/tools/explore.ts" },
  { score: 0.549, relativePath: "website/docs/api/tools.md" },
  { score: 0.548, relativePath: "src/core/infra/errors.ts" },
];

describe("computeSearchConfidence", () => {
  describe("shape separation", () => {
    it("scores a peaked, clustered response above a flat, scattered one", () => {
      expect(computeSearchConfidence(FIND).value).toBeGreaterThan(computeSearchConfidence(NOISE).value);
    });

    it("ignores absolute magnitude — a uniformly rescaled response keeps its confidence", () => {
      // Halving every score preserves peak (ratio), CV (scale-free) and paths.
      const halved = FIND.map((r) => ({ ...r, score: r.score / 2 }));
      expect(computeSearchConfidence(halved).value).toBeCloseTo(computeSearchConfidence(FIND).value, 6);
    });

    it("labels a flat scattered response low and a peaked clustered response above low", () => {
      expect(computeSearchConfidence(NOISE).label).toBe("low");
      expect(computeSearchConfidence(FIND).label).not.toBe("low");
    });
  });

  describe("peak — leader separation", () => {
    it("reaches its maximum when the tail collapses to zero", () => {
      // peak = (1 - median(0,0,0)) / 1 = 1; spread and locality also maximal here:
      // one directory, and CV of [1,0,0,0] is large enough to saturate.
      const { value } = computeSearchConfidence([
        { score: 1, relativePath: "src/a/x.ts" },
        { score: 0, relativePath: "src/a/y.ts" },
        { score: 0, relativePath: "src/a/z.ts" },
        { score: 0, relativePath: "src/a/w.ts" },
      ]);
      expect(value).toBeGreaterThan(0.9);
    });

    it("falls to zero when every score is identical", () => {
      // peak = (0.5 - 0.5) / 0.5 = 0, spread = CV 0 → 0. Only locality survives.
      const flat = Array.from({ length: 6 }, (_, i) => ({ score: 0.5, relativePath: `src/d${i}/f.ts` }));
      expect(computeSearchConfidence(flat).value).toBeCloseTo(0, 6);
    });

    it("is unaffected by a single strong runner-up (median tail, not mean)", () => {
      const oneRival = [
        { score: 0.9, relativePath: "src/a/x.ts" },
        { score: 0.88, relativePath: "src/a/y.ts" },
        { score: 0.2, relativePath: "src/a/z.ts" },
        { score: 0.19, relativePath: "src/a/w.ts" },
        { score: 0.18, relativePath: "src/a/v.ts" },
      ];
      // median(0.88, 0.2, 0.19, 0.18) = (0.2 + 0.19) / 2 = 0.195 → peak = (0.9 - 0.195) / 0.9
      expect(computeSearchConfidence(oneRival).value).toBeGreaterThan(0.5);
    });
  });

  describe("locality — directory entropy", () => {
    it("prefers a clustered response over the same scores scattered", () => {
      const scattered = FIND.map((r, i) => ({ ...r, relativePath: `src/pkg${i}/file.ts` }));
      expect(computeSearchConfidence(FIND).value).toBeGreaterThan(computeSearchConfidence(scattered).value);
    });

    it("cannot by itself lift a flat response out of low", () => {
      // Perfect locality (one directory) on top of zero peak and zero spread:
      // 0.2 weight alone must stay under the medium cut-point.
      const flatButClustered = Array.from({ length: 6 }, () => ({ score: 0.5, relativePath: "src/a/f.ts" }));
      expect(computeSearchConfidence(flatButClustered).label).toBe("low");
    });

    it("treats results without a path as unlocalizable rather than clustered", () => {
      const noPaths = NOISE.map(({ score }) => ({ score }));
      expect(computeSearchConfidence(noPaths).value).toBeCloseTo(computeSearchConfidence(NOISE).value, 6);
    });
  });

  describe("degenerate inputs", () => {
    it("reports low confidence for an empty result set", () => {
      expect(computeSearchConfidence([])).toEqual({ value: 0, label: "low" });
    });

    it("returns a value in [0,1] for a single result", () => {
      const { value } = computeSearchConfidence([{ score: 0.7, relativePath: "src/a/x.ts" }]);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    });

    it("survives a non-positive leader without producing NaN", () => {
      const { value, label } = computeSearchConfidence([
        { score: 0, relativePath: "src/a/x.ts" },
        { score: -0.1, relativePath: "src/b/y.ts" },
        { score: -0.2, relativePath: "src/c/z.ts" },
      ]);
      expect(Number.isFinite(value)).toBe(true);
      expect(["low", "medium", "high"]).toContain(label);
    });
  });

  describe("calibration seam", () => {
    it("a smaller spread half-point makes the same dispersion count for more", () => {
      const sensitive = computeSearchConfidence(FIND, { spreadHalfPoint: 0.01 });
      const dull = computeSearchConfidence(FIND, { spreadHalfPoint: 1 });
      expect(sensitive.value).toBeGreaterThan(dull.value);
    });

    it("defaults to the shipped constant when no override is given", () => {
      const shipped = computeSearchConfidence(FIND);
      const explicit = computeSearchConfidence(FIND, {});
      expect(explicit.value).toBe(shipped.value);
    });
  });

  describe("output contract", () => {
    it("returns a two-decimal value and one of the three labels", () => {
      const { value, label } = computeSearchConfidence(FIND);
      expect(value).toBe(Math.round(value * 100) / 100);
      expect(["low", "medium", "high"]).toContain(label);
    });

    it("never leaves [0,1] regardless of input shape", () => {
      const wild = [
        { score: 12, relativePath: "src/a/x.ts" },
        { score: 0.001, relativePath: "src/a/y.ts" },
        { score: 0.0005, relativePath: "src/a/z.ts" },
      ];
      const { value } = computeSearchConfidence(wild);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    });
  });
});
