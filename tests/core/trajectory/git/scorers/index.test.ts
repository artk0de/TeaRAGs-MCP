import { describe, expect, it } from "vitest";

import type { Scorer } from "../../../../../src/core/api/scorer.js";
import { gitScorers } from "../../../../../src/core/trajectory/git/scorers/index.js";

/**
 * Helper: build a payload matching the flat structure used by reranker.ts
 * (payload.git.file.* for file-level, payload.git.chunk.* for chunk-level).
 */
function payload(
  fileFields: Record<string, unknown> = {},
  chunkFields?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const git: Record<string, unknown> = {
    file: { ...fileFields },
  };
  if (chunkFields) {
    git.chunk = { ...chunkFields };
  }
  return { git, ...extra };
}

/** Flat payload (old format) — fields at git root level */
function flatPayload(fields: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { git: { ...fields }, ...extra };
}

/** Find a scorer by name from the exported array */
function findScorer(name: string): Scorer {
  const s = gitScorers.find((sc) => sc.name === name);
  if (!s) throw new Error(`Scorer "${name}" not found in gitScorers`);
  return s;
}

describe("gitScorers", () => {
  it("should export exactly 14 scorers", () => {
    expect(gitScorers).toHaveLength(14);
  });

  it("should have unique names", () => {
    const names = gitScorers.map((s) => s.name);
    expect(new Set(names).size).toBe(14);
  });

  it("should all be class instances (not plain objects)", () => {
    for (const scorer of gitScorers) {
      expect(scorer.constructor.name).not.toBe("Object");
    }
  });

  it("should all implement the Scorer interface", () => {
    for (const scorer of gitScorers) {
      expect(typeof scorer.name).toBe("string");
      expect(typeof scorer.description).toBe("string");
      expect(typeof scorer.extract).toBe("function");
    }
  });

  describe("RecencyScorer", () => {
    const scorer = findScorer("recency");

    it("should return 1 for ageDays=0 (most recent)", () => {
      expect(scorer.extract(payload({ ageDays: 0 }))).toBe(1);
    });

    it("should return 0 for ageDays=365 (1 year old)", () => {
      expect(scorer.extract(payload({ ageDays: 365 }))).toBe(0);
    });

    it("should return ~0.5 for ageDays=182", () => {
      const result = scorer.extract(payload({ ageDays: 182 }));
      expect(result).toBeCloseTo(1 - 182 / 365, 5);
    });

    it("should clamp values beyond 365", () => {
      expect(scorer.extract(payload({ ageDays: 1000 }))).toBe(0);
    });

    it("should return 1 when no git data present", () => {
      // ageDays defaults to 0, so recency = 1 - 0/365 = 1
      expect(scorer.extract({})).toBe(1);
    });

    it("should have defaultBound=365", () => {
      expect(scorer.defaultBound).toBe(365);
    });
  });

  describe("StabilityScorer", () => {
    const scorer = findScorer("stability");

    it("should return 1 for commitCount=0 (most stable)", () => {
      expect(scorer.extract(payload({ commitCount: 0 }))).toBe(1);
    });

    it("should return 0 for commitCount=50", () => {
      expect(scorer.extract(payload({ commitCount: 50 }))).toBe(0);
    });

    it("should return ~0.5 for commitCount=25", () => {
      expect(scorer.extract(payload({ commitCount: 25 }))).toBeCloseTo(0.5, 5);
    });

    it("should have defaultBound=50", () => {
      expect(scorer.defaultBound).toBe(50);
    });
  });

  describe("ChurnScorer", () => {
    const scorer = findScorer("churn");

    it("should return 0 for commitCount=0", () => {
      expect(scorer.extract(payload({ commitCount: 0 }))).toBe(0);
    });

    it("should return 1 for commitCount=50", () => {
      expect(scorer.extract(payload({ commitCount: 50 }))).toBe(1);
    });

    it("should return 0.5 for commitCount=25", () => {
      expect(scorer.extract(payload({ commitCount: 25 }))).toBeCloseTo(0.5, 5);
    });

    it("should have defaultBound=50", () => {
      expect(scorer.defaultBound).toBe(50);
    });
  });

  describe("AgeScorer", () => {
    const scorer = findScorer("age");

    it("should return 0 for ageDays=0", () => {
      expect(scorer.extract(payload({ ageDays: 0 }))).toBe(0);
    });

    it("should return 1 for ageDays=365", () => {
      expect(scorer.extract(payload({ ageDays: 365 }))).toBe(1);
    });

    it("should have defaultBound=365", () => {
      expect(scorer.defaultBound).toBe(365);
    });
  });

  describe("OwnershipScorer", () => {
    const scorer = findScorer("ownership");

    it("should use dominantAuthorPct when available", () => {
      expect(scorer.extract(payload({ dominantAuthorPct: 90, commitCount: 10 }))).toBeCloseTo(0.9, 5);
    });

    it("should return 1 for single author when dominantAuthorPct absent", () => {
      expect(scorer.extract(payload({ authors: ["alice"], commitCount: 10 }))).toBe(1);
    });

    it("should return 1/n for n authors when dominantAuthorPct absent", () => {
      expect(scorer.extract(payload({ authors: ["a", "b", "c"], commitCount: 10 }))).toBeCloseTo(1 / 3, 5);
    });

    it("should return 0 when no authors", () => {
      expect(scorer.extract(payload({ commitCount: 10 }))).toBe(0);
    });

    it("should be flagged as needsConfidence", () => {
      expect(scorer.needsConfidence).toBe(true);
    });

    it("should have defaultBound=100", () => {
      expect(scorer.defaultBound).toBe(100);
    });
  });

  describe("BugFixScorer", () => {
    const scorer = findScorer("bugFix");

    it("should normalize bugFixRate/100", () => {
      expect(scorer.extract(payload({ bugFixRate: 50, commitCount: 10 }))).toBeCloseTo(0.5, 5);
    });

    it("should return 0 for bugFixRate=0", () => {
      expect(scorer.extract(payload({ bugFixRate: 0, commitCount: 10 }))).toBe(0);
    });

    it("should cap at 1 for bugFixRate=100", () => {
      expect(scorer.extract(payload({ bugFixRate: 100, commitCount: 10 }))).toBe(1);
    });

    it("should be flagged as needsConfidence", () => {
      expect(scorer.needsConfidence).toBe(true);
    });

    it("should have defaultBound=100", () => {
      expect(scorer.defaultBound).toBe(100);
    });
  });

  describe("VolatilityScorer", () => {
    const scorer = findScorer("volatility");

    it("should normalize churnVolatility/60", () => {
      expect(scorer.extract(payload({ churnVolatility: 30, commitCount: 10 }))).toBeCloseTo(0.5, 5);
    });

    it("should return 0 when missing", () => {
      expect(scorer.extract(payload({ commitCount: 10 }))).toBe(0);
    });

    it("should be flagged as needsConfidence", () => {
      expect(scorer.needsConfidence).toBe(true);
    });
  });

  describe("DensityScorer", () => {
    const scorer = findScorer("density");

    it("should normalize changeDensity/20", () => {
      expect(scorer.extract(payload({ changeDensity: 10, commitCount: 10 }))).toBeCloseTo(0.5, 5);
    });

    it("should be flagged as needsConfidence", () => {
      expect(scorer.needsConfidence).toBe(true);
    });
  });

  describe("ChunkChurnScorer", () => {
    const scorer = findScorer("chunkChurn");

    it("should normalize chunk.commitCount/30", () => {
      expect(scorer.extract(payload({}, { commitCount: 15 }))).toBeCloseTo(0.5, 5);
    });

    it("should return 0 when no chunk data", () => {
      expect(scorer.extract(payload({ commitCount: 10 }))).toBe(0);
    });

    it("should have defaultBound=30", () => {
      expect(scorer.defaultBound).toBe(30);
    });
  });

  describe("RelativeChurnScorer", () => {
    const scorer = findScorer("relativeChurnNorm");

    it("should normalize relativeChurn/5.0", () => {
      expect(scorer.extract(payload({ relativeChurn: 2.5, commitCount: 10 }))).toBeCloseTo(0.5, 5);
    });

    it("should be flagged as needsConfidence", () => {
      expect(scorer.needsConfidence).toBe(true);
    });

    it("should have defaultBound=5.0", () => {
      expect(scorer.defaultBound).toBe(5.0);
    });
  });

  describe("BurstActivityScorer", () => {
    const scorer = findScorer("burstActivity");

    it("should normalize recencyWeightedFreq/10.0", () => {
      expect(scorer.extract(payload({ recencyWeightedFreq: 5.0 }))).toBeCloseTo(0.5, 5);
    });

    it("should return 0 when missing", () => {
      expect(scorer.extract(payload({}))).toBe(0);
    });

    it("should have defaultBound=10.0", () => {
      expect(scorer.defaultBound).toBe(10.0);
    });
  });

  describe("KnowledgeSiloScorer", () => {
    const scorer = findScorer("knowledgeSilo");

    it("should return 1.0 for contributorCount=1", () => {
      expect(scorer.extract(payload({ contributorCount: 1, commitCount: 10 }))).toBe(1.0);
    });

    it("should return 0.5 for contributorCount=2", () => {
      expect(scorer.extract(payload({ contributorCount: 2, commitCount: 10 }))).toBe(0.5);
    });

    it("should return 0 for contributorCount=3+", () => {
      expect(scorer.extract(payload({ contributorCount: 5, commitCount: 10 }))).toBe(0);
    });

    it("should return 0 when missing", () => {
      expect(scorer.extract(payload({}))).toBe(0);
    });

    it("should prefer chunk-level contributorCount", () => {
      expect(scorer.extract(payload({ contributorCount: 5 }, { contributorCount: 1 }))).toBe(1.0);
    });

    it("should be flagged as needsConfidence", () => {
      expect(scorer.needsConfidence).toBe(true);
    });
  });

  describe("ChunkRelativeChurnScorer", () => {
    const scorer = findScorer("chunkRelativeChurn");

    it("should normalize chunk.churnRatio/1.0", () => {
      expect(scorer.extract(payload({}, { churnRatio: 0.5 }))).toBeCloseTo(0.5, 5);
    });

    it("should return 0 when no chunk data", () => {
      expect(scorer.extract(payload({}))).toBe(0);
    });

    it("should have defaultBound=1.0", () => {
      expect(scorer.defaultBound).toBe(1.0);
    });
  });

  describe("BlockPenaltyScorer", () => {
    const scorer = findScorer("blockPenalty");

    it("should return 1.0 for block chunks without chunk-level data", () => {
      expect(scorer.extract({ chunkType: "block", git: { file: { commitCount: 10 } } })).toBe(1.0);
    });

    it("should return 0 for block chunks WITH chunk-level data", () => {
      expect(
        scorer.extract({ chunkType: "block", git: { file: { commitCount: 10 }, chunk: { commitCount: 5 } } }),
      ).toBe(0);
    });

    it("should return 0 for non-block chunks", () => {
      expect(scorer.extract({ chunkType: "function", git: { file: { commitCount: 10 } } })).toBe(0);
    });

    it("should return 0 when no chunkType", () => {
      expect(scorer.extract({ git: { file: { commitCount: 10 } } })).toBe(0);
    });
  });

  describe("backward compatibility with flat payload format", () => {
    it("RecencyScorer should read ageDays from flat git root", () => {
      const scorer = findScorer("recency");
      expect(scorer.extract(flatPayload({ ageDays: 100 }))).toBeCloseTo(1 - 100 / 365, 5);
    });

    it("ChurnScorer should read commitCount from flat git root", () => {
      const scorer = findScorer("churn");
      expect(scorer.extract(flatPayload({ commitCount: 25 }))).toBeCloseTo(0.5, 5);
    });

    it("OwnershipScorer should read dominantAuthorPct from flat git root", () => {
      const scorer = findScorer("ownership");
      expect(scorer.extract(flatPayload({ dominantAuthorPct: 80, commitCount: 10 }))).toBeCloseTo(0.8, 5);
    });
  });

  describe("edge cases", () => {
    it("should return 0 for all scorers when payload is empty", () => {
      for (const scorer of gitScorers) {
        const result = scorer.extract({});
        // RecencyScorer returns 1 (1 - 0/365 = 1) and StabilityScorer returns 1 (1 - 0/50 = 1)
        if (scorer.name === "recency" || scorer.name === "stability") {
          expect(result).toBe(1);
        } else {
          expect(result).toBe(0);
        }
      }
    });

    it("should handle negative values gracefully (clamp to 0)", () => {
      const churn = findScorer("churn");
      expect(churn.extract(payload({ commitCount: -5 }))).toBe(0);
    });
  });
});
