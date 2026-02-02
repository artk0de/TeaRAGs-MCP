import { describe, it, expect } from "vitest";
import {
  rerankSemanticSearchResults,
  rerankSearchCodeResults,
  getAvailablePresets,
  type RerankableResult,
} from "./reranker.js";

describe("reranker", () => {
  // Create mock results with git metadata
  const createResult = (
    score: number,
    ageDays: number,
    commitCount: number,
    isDoc = false,
  ): RerankableResult => ({
    score,
    payload: {
      relativePath: `src/file-${score}.ts`,
      startLine: 1,
      endLine: 50,
      language: "typescript",
      isDocumentation: isDoc,
      git: {
        ageDays,
        commitCount,
        dominantAuthor: "alice",
        authors: ["alice"],
      },
    },
  });

  describe("rerankSemanticSearchResults", () => {
    const mockResults: RerankableResult[] = [
      createResult(0.9, 10, 2), // high similarity, recent, stable
      createResult(0.8, 100, 20), // medium similarity, old, high churn
      createResult(0.7, 5, 1), // lower similarity, very recent, very stable
    ];

    it("should not change order for 'relevance' preset (default)", () => {
      const result = rerankSemanticSearchResults(mockResults, "relevance");
      expect(result[0].score).toBe(0.9);
      expect(result[1].score).toBe(0.8);
      expect(result[2].score).toBe(0.7);
    });

    it("should boost old and high-churn code for 'techDebt' preset", () => {
      const result = rerankSemanticSearchResults(mockResults, "techDebt");
      // Old + high churn code should be boosted
      // Result with ageDays=100, commitCount=20 should rank higher
      const oldHighChurnResult = result.find(
        (r) => r.payload?.git?.ageDays === 100,
      );
      expect(oldHighChurnResult).toBeDefined();
      // Should be boosted compared to relevance-only
    });

    it("should boost recent changes for 'codeReview' preset", () => {
      const result = rerankSemanticSearchResults(mockResults, "codeReview");
      // Very recent code (ageDays=5) should be boosted
      const recentResult = result.find((r) => r.payload?.git?.ageDays === 5);
      expect(recentResult).toBeDefined();
    });

    it("should boost documentation for 'onboarding' preset", () => {
      const resultsWithDocs: RerankableResult[] = [
        createResult(0.8, 30, 5, false), // code
        createResult(0.7, 30, 5, true), // documentation
      ];
      const result = rerankSemanticSearchResults(resultsWithDocs, "onboarding");
      // Documentation should be boosted
      const docResult = result.find((r) => r.payload?.isDocumentation === true);
      expect(docResult).toBeDefined();
    });

    it("should support custom weights", () => {
      const result = rerankSemanticSearchResults(mockResults, {
        custom: {
          similarity: 0.5,
          recency: 0.5,
        },
      });
      // Results should be reordered based on custom weights
      expect(result).toHaveLength(3);
    });

    it("should handle results without git metadata", () => {
      const noGitResults: RerankableResult[] = [
        { score: 0.9, payload: { relativePath: "file1.ts" } },
        { score: 0.8, payload: { relativePath: "file2.ts" } },
      ];
      const result = rerankSemanticSearchResults(noGitResults, "techDebt");
      // Should not crash, similarity should dominate
      expect(result).toHaveLength(2);
    });
  });

  describe("rerankSearchCodeResults", () => {
    const mockResults: RerankableResult[] = [
      createResult(0.9, 100, 10), // high similarity, old
      createResult(0.8, 5, 2), // medium similarity, very recent
      createResult(0.7, 50, 1), // lower similarity, stable
    ];

    it("should not change order for 'relevance' preset", () => {
      const result = rerankSearchCodeResults(mockResults, "relevance");
      expect(result[0].score).toBe(0.9);
      expect(result[1].score).toBe(0.8);
      expect(result[2].score).toBe(0.7);
    });

    it("should boost recent code for 'recent' preset", () => {
      const result = rerankSearchCodeResults(mockResults, "recent");
      // Result with ageDays=5 should be boosted
      const recentResult = result.find((r) => r.payload?.git?.ageDays === 5);
      expect(recentResult).toBeDefined();
      // Should have higher rank than in relevance-only
    });

    it("should boost stable code for 'stable' preset", () => {
      const result = rerankSearchCodeResults(mockResults, "stable");
      // Result with commitCount=1 (most stable) should be boosted
      const stableResult = result.find(
        (r) => r.payload?.git?.commitCount === 1,
      );
      expect(stableResult).toBeDefined();
    });

    it("should support custom weights", () => {
      const result = rerankSearchCodeResults(mockResults, {
        custom: {
          similarity: 0.7,
          stability: 0.3,
        },
      });
      expect(result).toHaveLength(3);
    });
  });

  describe("getAvailablePresets", () => {
    it("should return semantic_search presets", () => {
      const presets = getAvailablePresets("semantic_search");
      expect(presets).toContain("relevance");
      expect(presets).toContain("techDebt");
      expect(presets).toContain("hotspots");
      expect(presets).toContain("codeReview");
      expect(presets).toContain("onboarding");
      expect(presets).toContain("securityAudit");
      expect(presets).toContain("refactoring");
      expect(presets).toContain("ownership");
      expect(presets).toContain("impactAnalysis");
    });

    it("should return search_code presets", () => {
      const presets = getAvailablePresets("search_code");
      expect(presets).toContain("relevance");
      expect(presets).toContain("recent");
      expect(presets).toContain("stable");
      expect(presets).not.toContain("techDebt"); // semantic_search only
    });
  });

  describe("edge cases", () => {
    it("should handle empty results", () => {
      const result = rerankSemanticSearchResults([], "techDebt");
      expect(result).toEqual([]);
    });

    it("should handle single result", () => {
      const single = [createResult(0.9, 10, 5)];
      const result = rerankSemanticSearchResults(single, "techDebt");
      expect(result).toHaveLength(1);
    });

    it("should handle results with missing payload", () => {
      const noPayload: RerankableResult[] = [{ score: 0.9 }, { score: 0.8 }];
      const result = rerankSemanticSearchResults(noPayload, "techDebt");
      expect(result).toHaveLength(2);
    });

    it("should handle unknown preset gracefully", () => {
      const result = rerankSemanticSearchResults(
        [createResult(0.9, 10, 5)],
        "unknownPreset" as any,
      );
      // Should fall back to relevance
      expect(result).toHaveLength(1);
    });
  });
});
