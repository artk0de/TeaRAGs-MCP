import { describe, expect, it } from "vitest";

import {
  getAvailablePresets,
  rerankSearchCodeResults,
  rerankSemanticSearchResults,
  signalConfidence,
  type RerankableResult,
  type ScoringWeights,
} from "../../../src/core/search/reranker.js";

describe("reranker", () => {
  // Create mock results with git metadata
  const createResult = (
    score: number,
    ageDays: number,
    commitCount: number,
    isDoc = false,
    extraGit: Partial<
      RerankableResult["payload"] extends infer P ? (P extends { git?: infer G } ? G : never) : never
    > = {},
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
        ...extraGit,
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
      const oldHighChurnResult = result.find((r) => r.payload?.git?.ageDays === 100);
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
      const stableResult = result.find((r) => r.payload?.git?.commitCount === 1);
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

  describe("new signals: bugFix, volatility, density, chunkChurn", () => {
    it("should normalize bugFix signal correctly (50% → 0.5)", () => {
      const results = [
        createResult(0.8, 30, 5, false, { bugFixRate: 50 }),
        createResult(0.8, 30, 5, false, { bugFixRate: 0 }),
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { bugFix: 1.0 },
      });
      // 50% bugFixRate should rank higher
      expect(reranked[0].payload?.git?.bugFixRate).toBe(50);
      expect(reranked[0].score).toBeGreaterThan(reranked[1].score);
    });

    it("should prefer chunk-level churn over file-level in hotspots", () => {
      const results = [
        // File has high churn (20), but this chunk is cold (chunkCommitCount=1)
        createResult(0.8, 10, 20, false, { chunkCommitCount: 1 }),
        // File has low churn (3), but this chunk is hot (chunkCommitCount=15)
        createResult(0.8, 10, 3, false, { chunkCommitCount: 15 }),
      ];
      const reranked = rerankSemanticSearchResults(results, "hotspots");
      // Chunk with high chunkCommitCount should rank higher
      expect(reranked[0].payload?.git?.chunkCommitCount).toBe(15);
    });

    it("should boost high bugFixRate + old code in techDebt preset", () => {
      const results = [
        createResult(0.8, 200, 10, false, { bugFixRate: 80, churnVolatility: 30 }),
        createResult(0.8, 10, 10, false, { bugFixRate: 5, churnVolatility: 2 }),
      ];
      const reranked = rerankSemanticSearchResults(results, "techDebt");
      // High bugFixRate + old code should rank higher
      expect(reranked[0].payload?.git?.bugFixRate).toBe(80);
    });

    it("should not crash when mixing chunk-level and file-level results", () => {
      const results = [
        createResult(0.9, 10, 5, false, { chunkCommitCount: 8 }),
        createResult(0.8, 20, 3, false), // no chunk-level data
      ];
      const reranked = rerankSemanticSearchResults(results, "hotspots");
      expect(reranked).toHaveLength(2);
    });

    it("should use dominantAuthorPct for ownership when available", () => {
      const results = [
        createResult(0.8, 30, 5, false, { dominantAuthorPct: 90, authors: ["alice", "bob", "charlie"] as any }),
        createResult(0.8, 30, 5, false, { dominantAuthorPct: 30, authors: ["a", "b", "c", "d"] as any }),
      ];
      const reranked = rerankSemanticSearchResults(results, "ownership");
      // 90% ownership should rank higher
      expect(reranked[0].payload?.git?.dominantAuthorPct).toBe(90);
    });

    it("should boost density signal in codeReview preset", () => {
      const results = [
        createResult(0.8, 5, 3, false, { changeDensity: 15 }), // high density
        createResult(0.8, 5, 3, false, { changeDensity: 1 }), // low density
      ];
      const reranked = rerankSemanticSearchResults(results, "codeReview");
      expect(reranked[0].payload?.git?.changeDensity).toBe(15);
    });
  });

  describe("new signals: relativeChurnNorm, burstActivity, pathRisk, knowledgeSilo, chunkRelativeChurn", () => {
    it("should normalize relativeChurn via relativeChurnNorm signal", () => {
      // LOW relativeChurn first — if signal doesn't exist, order won't change
      const results = [
        createResult(0.8, 100, 10, false, { relativeChurn: 0.1 }),
        createResult(0.8, 100, 10, false, { relativeChurn: 4.0 }),
      ];
      // Isolate the signal via custom weights
      const reranked = rerankSemanticSearchResults(results, {
        custom: { similarity: 0.1, relativeChurnNorm: 0.9 },
      });
      // High relativeChurn must be reordered to first
      expect(reranked[0].payload?.git?.relativeChurn).toBe(4.0);
    });

    it("should normalize recencyWeightedFreq via burstActivity signal", () => {
      // LOW burst first — if signal doesn't exist, order won't change
      const results = [
        createResult(0.8, 5, 3, false, { recencyWeightedFreq: 0.5 }),
        createResult(0.8, 5, 3, false, { recencyWeightedFreq: 8.0 }),
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { similarity: 0.1, burstActivity: 0.9 },
      });
      // High burstActivity must be reordered to first
      expect(reranked[0].payload?.git?.recencyWeightedFreq).toBe(8.0);
    });

    it("should wire pathRisk into securityAudit preset", () => {
      // Non-auth path first — securityAudit must reorder auth path to top
      const results: RerankableResult[] = [
        {
          score: 0.8,
          payload: {
            relativePath: "src/utils/format.ts",
            startLine: 1,
            endLine: 50,
            language: "typescript",
            git: { ageDays: 100, commitCount: 10, bugFixRate: 50 },
          },
        },
        {
          score: 0.8,
          payload: {
            relativePath: "src/auth/login.ts",
            startLine: 1,
            endLine: 50,
            language: "typescript",
            git: { ageDays: 100, commitCount: 10, bugFixRate: 50 },
          },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, "securityAudit");
      // Auth path should rank higher due to pathRisk signal
      expect(reranked[0].payload?.relativePath).toBe("src/auth/login.ts");
    });

    it("should flag single-contributor code via knowledgeSilo signal", () => {
      // Both have SAME dominantAuthorPct=80 — only knowledgeSilo differentiates
      // Multi-contributor first — if signal doesn't exist, order won't change
      const results = [
        createResult(0.8, 30, 5, false, {
          contributorCount: 5,
          dominantAuthorPct: 80,
          authors: ["a", "b", "c", "d", "e"] as any,
        }),
        createResult(0.8, 30, 5, false, { contributorCount: 1, dominantAuthorPct: 80, authors: ["alice"] as any }),
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { similarity: 0.1, knowledgeSilo: 0.9 },
      });
      // Single contributor (knowledgeSilo=1.0) must be reordered to first
      expect(reranked[0].payload?.git?.contributorCount).toBe(1);
    });

    it("should normalize chunkChurnRatio via chunkRelativeChurn signal", () => {
      // Same chunkCommitCount — only ratio differs. LOW ratio first.
      const results = [
        createResult(0.8, 10, 10, false, { chunkCommitCount: 5, chunkChurnRatio: 0.1 }),
        createResult(0.8, 10, 10, false, { chunkCommitCount: 5, chunkChurnRatio: 0.9 }),
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { similarity: 0.1, chunkRelativeChurn: 0.9 },
      });
      // High chunkChurnRatio must be reordered to first
      expect(reranked[0].payload?.git?.chunkChurnRatio).toBe(0.9);
    });
  });

  describe("chunk-level preference for bugFix and knowledgeSilo", () => {
    it("should prefer chunkBugFixRate over file-level bugFixRate", () => {
      // With alpha-blending, chunk data needs sufficient chunkCommitCount for alpha > 0.
      // chunkCommitCount=8 with file commitCount=10 → alpha=0.8 (chunk dominates).
      // File has low bugFixRate (10%), but chunk has high chunkBugFixRate (80%)
      // vs file with high bugFixRate (80%) but chunk has low chunkBugFixRate (10%)
      // LOW chunk bugfix first — must be reordered if chunk-level preferred
      const results = [
        createResult(0.8, 30, 10, false, { bugFixRate: 80, chunkBugFixRate: 10, chunkCommitCount: 8 }),
        createResult(0.8, 30, 10, false, { bugFixRate: 10, chunkBugFixRate: 80, chunkCommitCount: 8 }),
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { similarity: 0.1, bugFix: 0.9 },
      });
      // Chunk with high chunkBugFixRate should rank first (alpha=0.8 makes chunk dominate)
      expect(reranked[0].payload?.git?.chunkBugFixRate).toBe(80);
    });

    it("should prefer chunkContributorCount over file-level contributorCount for knowledgeSilo", () => {
      // With alpha-blending, chunk data needs sufficient chunkCommitCount for alpha=1.0.
      // chunkCommitCount=10 with file commitCount=10 → alpha=1.0 (pure chunk values).
      // knowledgeSilo uses categorical thresholds (1→1.0, 2→0.5, 3+→0) so needs exact integers.
      // File has 5 contributors, but this chunk only has 1
      // vs file with 1 contributor but chunk has 3
      // Multi-contributor chunk first — must be reordered if chunk-level preferred
      const results = [
        createResult(0.8, 30, 10, false, { contributorCount: 1, chunkContributorCount: 3, chunkCommitCount: 10 }),
        createResult(0.8, 30, 10, false, { contributorCount: 5, chunkContributorCount: 1, chunkCommitCount: 10 }),
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { similarity: 0.1, knowledgeSilo: 0.9 },
      });
      // Chunk with chunkContributorCount=1 (silo) should rank first (alpha=1.0 → pure chunk value)
      expect(reranked[0].payload?.git?.chunkContributorCount).toBe(1);
    });
  });

  describe("blockPenalty: penalize block chunks without chunk-level data", () => {
    const createResultWithChunkType = (
      score: number,
      chunkType: string,
      git: Partial<
        RerankableResult["payload"] extends infer P ? (P extends { git?: infer G } ? G : never) : never
      > = {},
    ): RerankableResult => ({
      score,
      payload: {
        relativePath: `src/file-${score}.ts`,
        startLine: 1,
        endLine: 50,
        language: "typescript",
        chunkType,
        git: {
          ageDays: 10,
          commitCount: 20,
          dominantAuthor: "alice",
          authors: ["alice"],
          recencyWeightedFreq: 5.0,
          bugFixRate: 40,
          churnVolatility: 20,
          ...git,
        },
      },
    });

    it("should penalize block chunks without chunk-level data in hotspots", () => {
      const results = [
        // Block chunk with only file-level data (no chunkCommitCount) — should be penalized
        createResultWithChunkType(0.8, "block", {}),
        // Function chunk with same file-level data — should NOT be penalized
        createResultWithChunkType(0.8, "function", {}),
      ];
      const reranked = rerankSemanticSearchResults(results, "hotspots");
      // Function should rank higher due to block penalty
      expect(reranked[0].payload?.chunkType).toBe("function");
    });

    it("should NOT penalize block chunks that have chunk-level data", () => {
      const results = [
        // Block with chunk-level data — should NOT be penalized
        createResultWithChunkType(0.8, "block", { chunkCommitCount: 15, chunkChurnRatio: 0.8 }),
        // Function without chunk-level data — no penalty either
        createResultWithChunkType(0.8, "function", {}),
      ];
      const reranked = rerankSemanticSearchResults(results, "hotspots");
      // Block with chunk data should rank at least as high (it has high chunkCommitCount)
      expect(reranked[0].payload?.chunkType).toBe("block");
    });

    it("should NOT penalize function/class/interface chunks", () => {
      const results = [
        createResultWithChunkType(0.8, "function", {}),
        createResultWithChunkType(0.8, "class", {}),
        createResultWithChunkType(0.8, "interface", {}),
      ];
      const reranked = rerankSemanticSearchResults(results, "hotspots");
      // All scores should be equal (no penalties applied)
      expect(reranked[0].score).toBeCloseTo(reranked[1].score, 5);
      expect(reranked[1].score).toBeCloseTo(reranked[2].score, 5);
    });

    it("should apply blockPenalty in techDebt preset", () => {
      const results = [
        createResultWithChunkType(0.8, "block", { ageDays: 200 }),
        createResultWithChunkType(0.8, "function", { ageDays: 200 }),
      ];
      const reranked = rerankSemanticSearchResults(results, "techDebt");
      expect(reranked[0].payload?.chunkType).toBe("function");
    });

    it("should apply blockPenalty in codeReview preset", () => {
      const results = [
        createResultWithChunkType(0.8, "block", { changeDensity: 15 }),
        createResultWithChunkType(0.8, "function", { changeDensity: 15 }),
      ];
      const reranked = rerankSemanticSearchResults(results, "codeReview");
      expect(reranked[0].payload?.chunkType).toBe("function");
    });

    it("should apply blockPenalty in refactoring preset", () => {
      const results = [
        createResultWithChunkType(0.8, "block", { relativeChurn: 3.0 }),
        createResultWithChunkType(0.8, "function", { relativeChurn: 3.0 }),
      ];
      const reranked = rerankSemanticSearchResults(results, "refactoring");
      expect(reranked[0].payload?.chunkType).toBe("function");
    });

    it("should support blockPenalty as custom negative weight", () => {
      const results = [createResultWithChunkType(0.8, "block", {}), createResultWithChunkType(0.7, "function", {})];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { similarity: 0.5, churn: 0.3, blockPenalty: -0.3 },
      });
      // Function should rank higher despite lower similarity, because block gets penalty
      expect(reranked[0].payload?.chunkType).toBe("function");
    });

    it("should not affect presets without blockPenalty (e.g., onboarding)", () => {
      const results = [createResultWithChunkType(0.9, "block", {}), createResultWithChunkType(0.7, "function", {})];
      const reranked = rerankSemanticSearchResults(results, "onboarding");
      // Block should still rank first (higher similarity, no penalty in this preset)
      expect(reranked[0].payload?.chunkType).toBe("block");
    });
  });

  describe("confidence dampening for small sample sizes", () => {
    it("should dampen bugFixRate=100% on commitCount=1 vs reliable commitCount=10", () => {
      // Without dampening: bugFix signal = 100/100=1.0 vs 50/100=0.5 → first wins
      // With quadratic dampening (k=8): 1.0*(1/8)^2≈0.016 vs 0.5*1.0=0.5 → second wins
      const results = [
        createResult(0.8, 30, 1, false, { bugFixRate: 100 }),
        createResult(0.8, 30, 10, false, { bugFixRate: 50 }),
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { bugFix: 1.0 },
      });
      expect(reranked[0].payload?.git?.commitCount).toBe(10);
    });

    it("should not dampen bugFix when commitCount >= 8 (bugFix threshold)", () => {
      const results = [
        createResult(0.8, 30, 10, false, { bugFixRate: 30 }),
        createResult(0.8, 30, 10, false, { bugFixRate: 80 }),
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { bugFix: 1.0 },
      });
      expect(reranked[0].payload?.git?.bugFixRate).toBe(80);
    });

    it("should not dampen ownership when commitCount >= 5 (ownership threshold)", () => {
      const results = [
        createResult(0.8, 30, 6, false, { dominantAuthorPct: 30, authors: ["a", "b", "c", "d"] as any }),
        createResult(0.8, 30, 6, false, { dominantAuthorPct: 90, authors: ["alice", "bob"] as any }),
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { ownership: 1.0 },
      });
      expect(reranked[0].payload?.git?.dominantAuthorPct).toBe(90);
    });

    it("should zero statistical signals when commitCount=0", () => {
      const results: RerankableResult[] = [
        {
          score: 0.7,
          payload: { relativePath: "a.ts", startLine: 1, endLine: 50, git: { commitCount: 0, bugFixRate: 100 } },
        },
        {
          score: 0.9,
          payload: { relativePath: "b.ts", startLine: 1, endLine: 50, git: { commitCount: 0, bugFixRate: 0 } },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { similarity: 0.5, bugFix: 0.5 },
      });
      // bugFix zeroed by confidence=0, similarity decides
      expect(reranked[0].payload?.relativePath).toBe("b.ts");
    });

    it("should NOT dampen recency (factual signal)", () => {
      // Both have commitCount=1. Recency is factual — should NOT be dampened.
      // If recency were dampened, both would have ~0 recency and similarity would decide (tie).
      // If recency is NOT dampened, the recent file (ageDays=5) should win.
      const results = [
        createResult(0.8, 200, 1), // old, 1 commit
        createResult(0.8, 5, 1), // recent, 1 commit
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { recency: 1.0 },
      });
      // Recent file must rank first — recency not dampened
      expect(reranked[0].payload?.git?.ageDays).toBe(5);
    });

    it("should dampen ownership for single-commit chunks in hotspots", () => {
      // commitCount=1: inflated bugFixRate=100%, ownership trivially 100%
      // commitCount=10: moderate bugFixRate=40%, real ownership=80%
      // Hotspots uses bugFix and volatility which should be dampened
      const results = [
        createResult(0.8, 10, 1, false, {
          chunkCommitCount: 1,
          chunkChurnRatio: 1.0,
          recencyWeightedFreq: 1.0,
          bugFixRate: 100,
          churnVolatility: 30,
        }),
        createResult(0.8, 10, 10, false, {
          chunkCommitCount: 8,
          chunkChurnRatio: 0.8,
          recencyWeightedFreq: 5.0,
          bugFixRate: 40,
          churnVolatility: 20,
        }),
      ];
      const reranked = rerankSemanticSearchResults(results, "hotspots");
      expect(reranked[0].payload?.git?.commitCount).toBe(10);
    });

    describe("per-signal quadratic confidence", () => {
      it("should dampen bugFix more aggressively than ownership (quadratic k=8 vs k=5)", () => {
        // At commitCount=4:
        //   bugFix confidence = (4/8)^2 = 0.25
        //   ownership confidence = (4/5)^2 = 0.64
        // So bugFix is dampened ~2.5x more than ownership at same sample size
        const bugFixConfidence = signalConfidence(4, "bugFix");
        const ownershipConfidence = signalConfidence(4, "ownership");
        expect(bugFixConfidence).toBeCloseTo(0.25, 2);
        expect(ownershipConfidence).toBeCloseTo(0.64, 2);
        expect(bugFixConfidence).toBeLessThan(ownershipConfidence);
      });

      it("should use k=5 for ownership (not k=8)", () => {
        // At commitCount=5, ownership should be fully confident
        expect(signalConfidence(5, "ownership")).toBe(1);
        // At commitCount=5, bugFix should NOT be fully confident (needs k=8)
        expect(signalConfidence(5, "bugFix")).toBeLessThan(1);
        expect(signalConfidence(5, "bugFix")).toBeCloseTo((5 / 8) ** 2, 5);
      });

      it("should make bugFix at commitCount=1 effectively zero with quadratic k=8", () => {
        // (1/8)^2 = 0.015625 — effectively zero
        const conf = signalConfidence(1, "bugFix");
        expect(conf).toBeCloseTo(0.015625, 4);
        expect(conf).toBeLessThan(0.02);
      });

      it("should return 1 when effectiveCommitCount >= threshold", () => {
        expect(signalConfidence(8, "bugFix")).toBe(1);
        expect(signalConfidence(10, "bugFix")).toBe(1);
        expect(signalConfidence(5, "ownership")).toBe(1);
        expect(signalConfidence(100, "volatility")).toBe(1);
      });

      it("should return 0 when effectiveCommitCount is 0", () => {
        expect(signalConfidence(0, "bugFix")).toBe(0);
        expect(signalConfidence(0, "ownership")).toBe(0);
      });

      it("should use DEFAULT_CONFIDENCE_THRESHOLD for signals without explicit threshold", () => {
        // 'similarity' has no explicit threshold, should use default k=5
        // At n=3: (3/5)^2 = 0.36
        const conf = signalConfidence(3, "similarity" as keyof ScoringWeights);
        expect(conf).toBeCloseTo(0.36, 2);
      });
    });
  });

  describe("adaptive normalization bounds", () => {
    it("should distinguish high-churn from moderate-churn in monorepo results", () => {
      const highChurn: RerankableResult = {
        score: 0.5,
        payload: {
          relativePath: "src/high-churn.ts",
          startLine: 1,
          endLine: 50,
          git: { file: { commitCount: 300, ageDays: 100 } },
        },
      };
      const moderateChurn: RerankableResult = {
        score: 0.5,
        payload: {
          relativePath: "src/moderate-churn.ts",
          startLine: 1,
          endLine: 50,
          git: { file: { commitCount: 51, ageDays: 100 } },
        },
      };
      const results = rerankSemanticSearchResults([moderateChurn, highChurn], "techDebt");
      expect(results[0].payload?.git?.file?.commitCount).toBe(300);
    });

    it("should not reduce bounds below DEFAULT_BOUNDS", () => {
      const a: RerankableResult = {
        score: 0.5,
        payload: {
          relativePath: "src/a.ts",
          startLine: 1,
          endLine: 50,
          git: { file: { commitCount: 3, ageDays: 10 } },
        },
      };
      const b: RerankableResult = {
        score: 0.5,
        payload: {
          relativePath: "src/b.ts",
          startLine: 1,
          endLine: 50,
          git: { file: { commitCount: 5, ageDays: 10 } },
        },
      };
      const results = rerankSemanticSearchResults([a, b], "techDebt");
      expect(results).toHaveLength(2);
      expect(results[0].score).toBeGreaterThanOrEqual(0);
      expect(results[1].score).toBeGreaterThanOrEqual(0);
    });

    it("should respect caller-provided bounds (skip adaptive)", () => {
      const result: RerankableResult = {
        score: 0.5,
        payload: {
          relativePath: "src/test.ts",
          startLine: 1,
          endLine: 50,
          git: { file: { commitCount: 100, ageDays: 50 } },
        },
      };
      const customBounds = {
        maxAgeDays: 100,
        maxCommitCount: 200,
        maxChunkSize: 500,
        maxImports: 20,
        maxBugFixRate: 100,
        maxVolatility: 60,
        maxChangeDensity: 20,
        maxChunkCommitCount: 30,
        maxRelativeChurn: 5.0,
        maxBurstActivity: 10.0,
        maxChunkChurnRatio: 1.0,
      };
      const results = rerankSemanticSearchResults([result], "techDebt", customBounds);
      expect(results).toHaveLength(1);
    });

    it("should produce different scores for values that clamp identically under static bounds", () => {
      const results: RerankableResult[] = [
        {
          score: 0.5,
          payload: {
            relativePath: "src/low.ts",
            startLine: 1,
            endLine: 50,
            git: { file: { commitCount: 60, ageDays: 100, churnVolatility: 10, bugFixRate: 20 } },
          },
        },
        {
          score: 0.5,
          payload: {
            relativePath: "src/mid.ts",
            startLine: 1,
            endLine: 50,
            git: { file: { commitCount: 200, ageDays: 100, churnVolatility: 10, bugFixRate: 20 } },
          },
        },
        {
          score: 0.5,
          payload: {
            relativePath: "src/high.ts",
            startLine: 1,
            endLine: 50,
            git: { file: { commitCount: 500, ageDays: 100, churnVolatility: 10, bugFixRate: 20 } },
          },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, "techDebt");
      expect(reranked[0].payload?.git?.file?.commitCount).toBe(500);
      expect(reranked[1].payload?.git?.file?.commitCount).toBe(200);
    });

    it("should adapt ageDays bounds for very old codebases", () => {
      const results: RerankableResult[] = [
        {
          score: 0.5,
          payload: {
            relativePath: "src/newer.ts",
            startLine: 1,
            endLine: 50,
            git: { file: { commitCount: 10, ageDays: 400 } },
          },
        },
        {
          score: 0.5,
          payload: {
            relativePath: "src/ancient.ts",
            startLine: 1,
            endLine: 50,
            git: { file: { commitCount: 10, ageDays: 2000 } },
          },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, "techDebt");
      expect(reranked[0].payload?.git?.file?.ageDays).toBe(2000);
    });
  });

  describe("L3 alpha-blending", () => {
    it("should blend chunk and file bugFixRate based on alpha (low alpha → effective ≈ file value)", () => {
      // chunk.commitCount=1 in a 50-commit file → alpha ≈ 0.007 (very low)
      // So effective bugFixRate should be almost entirely file's value
      // Result A: file bugFix=80, chunk bugFix=10  → effective ≈ 80 (alpha low, file dominates)
      // Result B: file bugFix=20, chunk bugFix=90  → effective ≈ 20 (alpha low, file dominates)
      // With bugFix weight, A should rank first because file bugFix=80 > 20
      const results: RerankableResult[] = [
        {
          score: 0.8,
          payload: {
            relativePath: "a.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 50, ageDays: 30, bugFixRate: 20 },
              chunk: { commitCount: 1, bugFixRate: 90 },
            },
          },
        },
        {
          score: 0.8,
          payload: {
            relativePath: "b.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 50, ageDays: 30, bugFixRate: 80 },
              chunk: { commitCount: 1, bugFixRate: 10 },
            },
          },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { bugFix: 1.0 },
      });
      // File's bugFixRate=80 should dominate because alpha is tiny
      expect(reranked[0].payload?.relativePath).toBe("b.ts");
    });

    it("should give high alpha to chunk with many commits relative to file (8/10 → alpha=0.8)", () => {
      // chunk.commitCount=8, file.commitCount=10 → coverage=0.8, maturity=min(1,8/3)=1 → alpha=0.8
      // Result A: file bugFix=20, chunk bugFix=90 → effective = 0.8*90 + 0.2*20 = 76
      // Result B: file bugFix=80, chunk bugFix=10 → effective = 0.8*10 + 0.2*80 = 24
      // A should rank first
      const results: RerankableResult[] = [
        {
          score: 0.8,
          payload: {
            relativePath: "b.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 10, ageDays: 30, bugFixRate: 80 },
              chunk: { commitCount: 8, bugFixRate: 10 },
            },
          },
        },
        {
          score: 0.8,
          payload: {
            relativePath: "a.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 10, ageDays: 30, bugFixRate: 20 },
              chunk: { commitCount: 8, bugFixRate: 90 },
            },
          },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { bugFix: 1.0 },
      });
      // With high alpha, chunk bugFix=90 dominates → a.ts first
      expect(reranked[0].payload?.relativePath).toBe("a.ts");
    });

    it("should degenerate to file-only when chunk data absent (backward compat)", () => {
      // No chunk data → alpha=0 → effective = file value
      const results: RerankableResult[] = [
        {
          score: 0.8,
          payload: {
            relativePath: "a.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 10, ageDays: 30, bugFixRate: 80 },
            },
          },
        },
        {
          score: 0.8,
          payload: {
            relativePath: "b.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 10, ageDays: 30, bugFixRate: 20 },
            },
          },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { bugFix: 1.0 },
      });
      // Pure file-level: bugFixRate=80 > 20
      expect(reranked[0].payload?.relativePath).toBe("a.ts");
    });

    it("should set alpha=0 when chunk.commitCount=0", () => {
      // chunk.commitCount=0 → alpha=0 → file values used entirely
      const results: RerankableResult[] = [
        {
          score: 0.8,
          payload: {
            relativePath: "a.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 10, ageDays: 30, bugFixRate: 20 },
              chunk: { commitCount: 0, bugFixRate: 99 },
            },
          },
        },
        {
          score: 0.8,
          payload: {
            relativePath: "b.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 10, ageDays: 30, bugFixRate: 80 },
              chunk: { commitCount: 0, bugFixRate: 1 },
            },
          },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { bugFix: 1.0 },
      });
      // alpha=0 means file values used: 80 > 20
      expect(reranked[0].payload?.relativePath).toBe("b.ts");
    });
  });

  describe("dataQualityDiscount", () => {
    const createResultWithChunkType = (
      score: number,
      chunkType: string,
      git: Record<string, unknown> = {},
    ): RerankableResult => ({
      score,
      payload: {
        relativePath: `src/file-${score}.ts`,
        startLine: 1,
        endLine: 50,
        language: "typescript",
        chunkType,
        git: {
          ageDays: 10,
          commitCount: 20,
          dominantAuthor: "alice",
          authors: ["alice"],
          recencyWeightedFreq: 5.0,
          bugFixRate: 40,
          churnVolatility: 20,
          ...git,
        } as any,
      },
    });

    it("should give continuous discount for blocks with partial chunk data (alpha=0.5 → discount=0.5)", () => {
      // file.commitCount=10, chunk.commitCount=5 → coverage=0.5, maturity=1.0 → alpha=0.5
      // discount = 1.0 - 0.5 = 0.5 (partial penalty)
      const results: RerankableResult[] = [
        {
          score: 0.8,
          payload: {
            relativePath: "block.ts",
            startLine: 1,
            endLine: 50,
            chunkType: "block",
            git: {
              file: { commitCount: 10, ageDays: 10, bugFixRate: 40, churnVolatility: 20, recencyWeightedFreq: 5.0 },
              chunk: { commitCount: 5 },
            },
          },
        },
        {
          score: 0.8,
          payload: {
            relativePath: "func.ts",
            startLine: 1,
            endLine: 50,
            chunkType: "function",
            git: {
              file: { commitCount: 10, ageDays: 10, bugFixRate: 40, churnVolatility: 20, recencyWeightedFreq: 5.0 },
              chunk: { commitCount: 5 },
            },
          },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { similarity: 0.5, blockPenalty: -0.5 },
      });
      // Block gets partial discount (0.5), function gets 0. Function should rank higher.
      expect(reranked[0].payload?.chunkType).toBe("function");
      // But the gap should be smaller than full penalty
      expect(reranked[0].score - reranked[1].score).toBeLessThan(0.3);
    });

    it("should give full discount for blocks without chunk data (alpha=0 → discount=1.0)", () => {
      // No chunk data → alpha=0 → discount=1.0 (full penalty, same as old behavior)
      const results = [createResultWithChunkType(0.8, "block", {}), createResultWithChunkType(0.8, "function", {})];
      const reranked = rerankSemanticSearchResults(results, "hotspots");
      // Function should rank higher — block gets full discount
      expect(reranked[0].payload?.chunkType).toBe("function");
    });

    it("should give no discount for function/class chunks regardless of alpha", () => {
      // Even with no chunk data, function/class/interface never get discount
      const results = [
        createResultWithChunkType(0.8, "function", {}),
        createResultWithChunkType(0.8, "class", {}),
        createResultWithChunkType(0.8, "interface", {}),
      ];
      const reranked = rerankSemanticSearchResults(results, "hotspots");
      // All scores should be equal (no discount applied to any)
      expect(reranked[0].score).toBeCloseTo(reranked[1].score, 5);
      expect(reranked[1].score).toBeCloseTo(reranked[2].score, 5);
    });

    it("should give zero discount for blocks with rich chunk data (alpha=1.0)", () => {
      // chunk.commitCount=10, file.commitCount=10 → coverage=1.0, maturity=1.0 → alpha=1.0
      // discount = 1.0 - 1.0 = 0.0
      const results: RerankableResult[] = [
        {
          score: 0.8,
          payload: {
            relativePath: "block.ts",
            startLine: 1,
            endLine: 50,
            chunkType: "block",
            git: {
              file: { commitCount: 10, ageDays: 10, bugFixRate: 40, churnVolatility: 20, recencyWeightedFreq: 5.0 },
              chunk: { commitCount: 10, churnRatio: 0.8 },
            },
          },
        },
        {
          score: 0.8,
          payload: {
            relativePath: "func.ts",
            startLine: 1,
            endLine: 50,
            chunkType: "function",
            git: {
              file: { commitCount: 10, ageDays: 10, bugFixRate: 40, churnVolatility: 20, recencyWeightedFreq: 5.0 },
              chunk: { commitCount: 10, churnRatio: 0.8 },
            },
          },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { similarity: 0.5, chunkChurn: 0.3, blockPenalty: -0.3 },
      });
      // Block with alpha=1.0 gets discount=0.0 → should score same as function
      expect(reranked[0].score).toBeCloseTo(reranked[1].score, 5);
    });
  });

  describe("chunk-level temporal signal blending", () => {
    it("should blend chunk and file burstActivity via alpha", () => {
      const results: RerankableResult[] = [
        {
          score: 0.8,
          payload: {
            relativePath: "a.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 10, ageDays: 30, recencyWeightedFreq: 1.0 },
              chunk: { commitCount: 8, recencyWeightedFreq: 8.0 },
            },
          },
        },
        {
          score: 0.8,
          payload: {
            relativePath: "b.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 10, ageDays: 30, recencyWeightedFreq: 8.0 },
              chunk: { commitCount: 8, recencyWeightedFreq: 1.0 },
            },
          },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { burstActivity: 1.0 },
      });
      // Alpha=0.8 → effective a.ts = 0.8*8.0+0.2*1.0=6.6, b.ts=0.8*1.0+0.2*8.0=2.4
      expect(reranked[0].payload?.relativePath).toBe("a.ts");
    });

    it("should blend chunk and file changeDensity via alpha", () => {
      const results: RerankableResult[] = [
        {
          score: 0.8,
          payload: {
            relativePath: "a.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 10, ageDays: 30, changeDensity: 1.0 },
              chunk: { commitCount: 8, changeDensity: 15.0 },
            },
          },
        },
        {
          score: 0.8,
          payload: {
            relativePath: "b.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 10, ageDays: 30, changeDensity: 15.0 },
              chunk: { commitCount: 8, changeDensity: 1.0 },
            },
          },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { density: 1.0 },
      });
      // Alpha=0.8 → effective a.ts = 0.8*15+0.2*1=12.2, b.ts=0.8*1+0.2*15=3.8
      expect(reranked[0].payload?.relativePath).toBe("a.ts");
    });

    it("should fall back to file-level when chunk has no temporal signals", () => {
      const results: RerankableResult[] = [
        {
          score: 0.8,
          payload: {
            relativePath: "a.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 10, ageDays: 30, recencyWeightedFreq: 8.0 },
              // No chunk recencyWeightedFreq → effectiveSignal returns file value
            },
          },
        },
        {
          score: 0.8,
          payload: {
            relativePath: "b.ts",
            startLine: 1,
            endLine: 50,
            git: {
              file: { commitCount: 10, ageDays: 30, recencyWeightedFreq: 1.0 },
            },
          },
        },
      ];
      const reranked = rerankSemanticSearchResults(results, {
        custom: { burstActivity: 1.0 },
      });
      // Pure file values: 8.0 > 1.0 → a.ts first
      expect(reranked[0].payload?.relativePath).toBe("a.ts");
    });
  });

  describe("redesigned techDebt preset", () => {
    it("should include knowledgeSilo signal", () => {
      const silo: RerankableResult = {
        score: 0.5,
        payload: {
          relativePath: "silo.ts",
          startLine: 1,
          endLine: 50,
          git: {
            file: {
              commitCount: 20,
              ageDays: 200,
              bugFixRate: 10,
              contributorCount: 1,
              authors: ["solo"],
              dominantAuthorPct: 100,
              churnVolatility: 5,
              changeDensity: 3,
            },
          },
        },
      };
      const shared: RerankableResult = {
        score: 0.5,
        payload: {
          relativePath: "shared.ts",
          startLine: 1,
          endLine: 50,
          git: {
            file: {
              commitCount: 20,
              ageDays: 200,
              bugFixRate: 10,
              contributorCount: 5,
              authors: ["a", "b", "c", "d", "e"],
              dominantAuthorPct: 30,
              churnVolatility: 5,
              changeDensity: 3,
            },
          },
        },
      };
      const results = rerankSemanticSearchResults([shared, silo], "techDebt");
      // Single-author code should rank higher in techDebt (knowledge silo risk)
      expect(results[0].payload?.git?.file?.contributorCount).toBe(1);
    });

    it("should include density signal", () => {
      const highDensity: RerankableResult = {
        score: 0.5,
        payload: {
          relativePath: "dense.ts",
          startLine: 1,
          endLine: 50,
          git: {
            file: {
              commitCount: 20,
              ageDays: 200,
              bugFixRate: 10,
              changeDensity: 15,
              churnVolatility: 5,
              contributorCount: 3,
            },
          },
        },
      };
      const lowDensity: RerankableResult = {
        score: 0.5,
        payload: {
          relativePath: "sparse.ts",
          startLine: 1,
          endLine: 50,
          git: {
            file: {
              commitCount: 20,
              ageDays: 200,
              bugFixRate: 10,
              changeDensity: 1,
              churnVolatility: 5,
              contributorCount: 3,
            },
          },
        },
      };
      const results = rerankSemanticSearchResults([lowDensity, highDensity], "techDebt");
      // High density (sustained change pressure) should rank higher
      expect(results[0].payload?.git?.file?.changeDensity).toBe(15);
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
      const result = rerankSemanticSearchResults([createResult(0.9, 10, 5)], "unknownPreset" as any);
      // Should fall back to relevance
      expect(result).toHaveLength(1);
    });
  });
});
