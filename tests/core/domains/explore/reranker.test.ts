import { describe, expect, it } from "vitest";

import type { RerankPreset } from "../../../../src/core/contracts/types/reranker.js";
import type {
  CollectionSignalStats,
  PayloadSignalDescriptor,
} from "../../../../src/core/contracts/types/trajectory.js";
import { resolvePresets } from "../../../../src/core/domains/explore/rerank/presets/index.js";
import { Reranker, type RerankableResult } from "../../../../src/core/domains/explore/reranker.js";
import { gitPayloadSignalDescriptors } from "../../../../src/core/domains/trajectory/git/payload-signals.js";
import { gitDerivedSignals } from "../../../../src/core/domains/trajectory/git/rerank/derived-signals/index.js";
import { GIT_PRESETS } from "../../../../src/core/domains/trajectory/git/rerank/presets/index.js";
import { staticDerivedSignals } from "../../../../src/core/domains/trajectory/static/rerank/derived-signals/index.js";
import { STATIC_PRESETS } from "../../../../src/core/domains/trajectory/static/rerank/presets/index.js";

const testPresets = resolvePresets([...STATIC_PRESETS, ...GIT_PRESETS], []);
const allDescriptors = [...gitDerivedSignals, ...staticDerivedSignals];
const testPayloadSignals: PayloadSignalDescriptor[] = gitPayloadSignalDescriptors;

describe("reranker", () => {
  const reranker = new Reranker(allDescriptors, testPresets, testPayloadSignals);

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

  describe("new signals: bugFix, volatility, density, chunkChurn", () => {
    it("should normalize bugFix signal correctly (50% -> 0.5)", () => {
      const results = [
        createResult(0.8, 30, 5, false, { bugFixRate: 50 }),
        createResult(0.8, 30, 5, false, { bugFixRate: 0 }),
      ];
      const reranked = reranker.rerank(results, { custom: { bugFix: 1.0 } }, "semantic_search");
      // 50% bugFixRate should rank higher
      expect(reranked[0].payload?.git?.bugFixRate).toBe(50);
      expect(reranked[0].score).toBeGreaterThan(reranked[1].score);
    });

    it("should prefer chunk-level churn over file-level in hotspots", () => {
      const results = [
        // File has high churn (20), but this chunk is cold (chunk.commitCount=1)
        createResult(0.8, 10, 20, false, { chunk: { commitCount: 1 } }),
        // File has low churn (3), but this chunk is hot (chunk.commitCount=15)
        createResult(0.8, 10, 3, false, { chunk: { commitCount: 15 } }),
      ];
      const reranked = reranker.rerank(results, "hotspots", "semantic_search");
      // Chunk with high chunk.commitCount should rank higher
      expect(reranked[0].payload?.git?.chunk?.commitCount).toBe(15);
    });

    it("should boost high bugFixRate + old code in techDebt preset", () => {
      const results = [
        createResult(0.8, 200, 10, false, { bugFixRate: 80, churnVolatility: 30 }),
        createResult(0.8, 10, 10, false, { bugFixRate: 5, churnVolatility: 2 }),
      ];
      const reranked = reranker.rerank(results, "techDebt", "semantic_search");
      // High bugFixRate + old code should rank higher
      expect(reranked[0].payload?.git?.bugFixRate).toBe(80);
    });

    it("should not crash when mixing chunk-level and file-level results", () => {
      const results = [
        createResult(0.9, 10, 5, false, { chunk: { commitCount: 8 } }),
        createResult(0.8, 20, 3, false), // no chunk-level data
      ];
      const reranked = reranker.rerank(results, "hotspots", "semantic_search");
      expect(reranked).toHaveLength(2);
    });

    it("should use dominantAuthorPct for ownership when available", () => {
      const results = [
        createResult(0.8, 30, 5, false, { dominantAuthorPct: 90, authors: ["alice", "bob", "charlie"] as any }),
        createResult(0.8, 30, 5, false, { dominantAuthorPct: 30, authors: ["a", "b", "c", "d"] as any }),
      ];
      const reranked = reranker.rerank(results, "ownership", "semantic_search");
      // 90% ownership should rank higher
      expect(reranked[0].payload?.git?.dominantAuthorPct).toBe(90);
    });

    it("should boost density signal in codeReview preset", () => {
      const results = [
        createResult(0.8, 5, 3, false, { changeDensity: 15 }), // high density
        createResult(0.8, 5, 3, false, { changeDensity: 1 }), // low density
      ];
      const reranked = reranker.rerank(results, "codeReview", "semantic_search");
      expect(reranked[0].payload?.git?.changeDensity).toBe(15);
    });
  });

  describe("new signals: relativeChurnNorm, burstActivity, pathRisk, knowledgeSilo, chunkRelativeChurn", () => {
    it("should normalize relativeChurn via relativeChurnNorm signal", () => {
      // LOW relativeChurn first -- if signal doesn't exist, order won't change
      const results = [
        createResult(0.8, 100, 10, false, { relativeChurn: 0.1 }),
        createResult(0.8, 100, 10, false, { relativeChurn: 4.0 }),
      ];
      // Isolate the signal via custom weights
      const reranked = reranker.rerank(
        results,
        { custom: { similarity: 0.1, relativeChurnNorm: 0.9 } },
        "semantic_search",
      );
      // High relativeChurn must be reordered to first
      expect(reranked[0].payload?.git?.relativeChurn).toBe(4.0);
    });

    it("should normalize recencyWeightedFreq via burstActivity signal", () => {
      // LOW burst first -- if signal doesn't exist, order won't change
      const results = [
        createResult(0.8, 5, 3, false, { recencyWeightedFreq: 0.5 }),
        createResult(0.8, 5, 3, false, { recencyWeightedFreq: 8.0 }),
      ];
      const reranked = reranker.rerank(results, { custom: { similarity: 0.1, burstActivity: 0.9 } }, "semantic_search");
      // High burstActivity must be reordered to first
      expect(reranked[0].payload?.git?.recencyWeightedFreq).toBe(8.0);
    });

    it("should wire pathRisk into securityAudit preset", () => {
      // Non-auth path first -- securityAudit must reorder auth path to top
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
      const reranked = reranker.rerank(results, "securityAudit", "semantic_search");
      // Auth path should rank higher due to pathRisk signal
      expect(reranked[0].payload?.relativePath).toBe("src/auth/login.ts");
    });

    it("should flag single-contributor code via knowledgeSilo signal", () => {
      // Both have SAME dominantAuthorPct=80 -- only knowledgeSilo differentiates
      // Multi-contributor first -- if signal doesn't exist, order won't change
      const results = [
        createResult(0.8, 30, 5, false, {
          contributorCount: 5,
          dominantAuthorPct: 80,
          authors: ["a", "b", "c", "d", "e"] as any,
        }),
        createResult(0.8, 30, 5, false, { contributorCount: 1, dominantAuthorPct: 80, authors: ["alice"] as any }),
      ];
      const reranked = reranker.rerank(results, { custom: { similarity: 0.1, knowledgeSilo: 0.9 } }, "semantic_search");
      // Single contributor (knowledgeSilo=1.0) must be reordered to first
      expect(reranked[0].payload?.git?.contributorCount).toBe(1);
    });

    it("should normalize chunkChurnRatio via chunkRelativeChurn signal", () => {
      // Same chunk.commitCount -- only ratio differs. LOW ratio first.
      const results = [
        createResult(0.8, 10, 10, false, { chunk: { commitCount: 5, churnRatio: 0.1 } }),
        createResult(0.8, 10, 10, false, { chunk: { commitCount: 5, churnRatio: 0.9 } }),
      ];
      const reranked = reranker.rerank(
        results,
        { custom: { similarity: 0.1, chunkRelativeChurn: 0.9 } },
        "semantic_search",
      );
      // High chunk.churnRatio must be reordered to first
      expect(reranked[0].payload?.git?.chunk?.churnRatio).toBe(0.9);
    });
  });

  describe("chunk-level preference for bugFix and knowledgeSilo", () => {
    it("should prefer chunk bugFixRate over file-level bugFixRate", () => {
      // With alpha-blending, chunk data needs sufficient chunk.commitCount for alpha > 0.
      // chunk.commitCount=8 with file commitCount=10 -> alpha=0.8 (chunk dominates).
      // File has low bugFixRate (10%), but chunk has high bugFixRate (80%)
      // vs file with high bugFixRate (80%) but chunk has low bugFixRate (10%)
      // LOW chunk bugfix first -- must be reordered if chunk-level preferred
      const results = [
        createResult(0.8, 30, 10, false, { bugFixRate: 80, chunk: { bugFixRate: 10, commitCount: 8 } }),
        createResult(0.8, 30, 10, false, { bugFixRate: 10, chunk: { bugFixRate: 80, commitCount: 8 } }),
      ];
      const reranked = reranker.rerank(results, { custom: { similarity: 0.1, bugFix: 0.9 } }, "semantic_search");
      // Chunk with high chunk.bugFixRate should rank first (alpha=0.8 makes chunk dominate)
      expect(reranked[0].payload?.git?.chunk?.bugFixRate).toBe(80);
    });

    it("should prefer chunk contributorCount over file-level contributorCount for knowledgeSilo", () => {
      // With alpha-blending, chunk data needs sufficient chunk.commitCount for alpha=1.0.
      // chunk.commitCount=10 with file commitCount=10 -> alpha=1.0 (pure chunk values).
      // knowledgeSilo uses categorical thresholds (1->1.0, 2->0.5, 3+->0) so needs exact integers.
      // File has 5 contributors, but this chunk only has 1
      // vs file with 1 contributor but chunk has 3
      // Multi-contributor chunk first -- must be reordered if chunk-level preferred
      const results = [
        createResult(0.8, 30, 10, false, { contributorCount: 1, chunk: { contributorCount: 3, commitCount: 10 } }),
        createResult(0.8, 30, 10, false, { contributorCount: 5, chunk: { contributorCount: 1, commitCount: 10 } }),
      ];
      const reranked = reranker.rerank(results, { custom: { similarity: 0.1, knowledgeSilo: 0.9 } }, "semantic_search");
      // Chunk with chunk.contributorCount=1 (silo) should rank first (alpha=1.0 -> pure chunk value)
      expect(reranked[0].payload?.git?.chunk?.contributorCount).toBe(1);
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
        // Block chunk with only file-level data (no chunkCommitCount) -- should be penalized
        createResultWithChunkType(0.8, "block", {}),
        // Function chunk with same file-level data -- should NOT be penalized
        createResultWithChunkType(0.8, "function", {}),
      ];
      const reranked = reranker.rerank(results, "hotspots", "semantic_search");
      // Function should rank higher due to block penalty
      expect(reranked[0].payload?.chunkType).toBe("function");
    });

    it("should NOT penalize block chunks that have chunk-level data", () => {
      const results = [
        // Block with chunk-level data -- should NOT be penalized
        createResultWithChunkType(0.8, "block", { chunk: { commitCount: 15, churnRatio: 0.8 } }),
        // Function without chunk-level data -- no penalty either
        createResultWithChunkType(0.8, "function", {}),
      ];
      const reranked = reranker.rerank(results, "hotspots", "semantic_search");
      // Block with chunk data should rank at least as high (it has high chunk.commitCount)
      expect(reranked[0].payload?.chunkType).toBe("block");
    });

    it("should NOT penalize function/class/interface chunks", () => {
      const results = [
        createResultWithChunkType(0.8, "function", {}),
        createResultWithChunkType(0.8, "class", {}),
        createResultWithChunkType(0.8, "interface", {}),
      ];
      const reranked = reranker.rerank(results, "hotspots", "semantic_search");
      // All scores should be equal (no penalties applied)
      expect(reranked[0].score).toBeCloseTo(reranked[1].score, 5);
      expect(reranked[1].score).toBeCloseTo(reranked[2].score, 5);
    });

    it("should apply blockPenalty in techDebt preset", () => {
      const results = [
        createResultWithChunkType(0.8, "block", { ageDays: 200 }),
        createResultWithChunkType(0.8, "function", { ageDays: 200 }),
      ];
      const reranked = reranker.rerank(results, "techDebt", "semantic_search");
      expect(reranked[0].payload?.chunkType).toBe("function");
    });

    it("should apply blockPenalty in codeReview preset", () => {
      const results = [
        createResultWithChunkType(0.8, "block", { changeDensity: 15 }),
        createResultWithChunkType(0.8, "function", { changeDensity: 15 }),
      ];
      const reranked = reranker.rerank(results, "codeReview", "semantic_search");
      expect(reranked[0].payload?.chunkType).toBe("function");
    });

    it("should apply blockPenalty in refactoring preset", () => {
      const results = [
        createResultWithChunkType(0.8, "block", { relativeChurn: 3.0 }),
        createResultWithChunkType(0.8, "function", { relativeChurn: 3.0 }),
      ];
      const reranked = reranker.rerank(results, "refactoring", "semantic_search");
      expect(reranked[0].payload?.chunkType).toBe("function");
    });

    it("should support blockPenalty as custom negative weight", () => {
      const results = [createResultWithChunkType(0.8, "block", {}), createResultWithChunkType(0.7, "function", {})];
      const reranked = reranker.rerank(
        results,
        { custom: { similarity: 0.5, churn: 0.3, blockPenalty: -0.3 } },
        "semantic_search",
      );
      // Function should rank higher despite lower similarity, because block gets penalty
      expect(reranked[0].payload?.chunkType).toBe("function");
    });

    it("should not affect presets without blockPenalty (e.g., onboarding)", () => {
      const results = [createResultWithChunkType(0.9, "block", {}), createResultWithChunkType(0.7, "function", {})];
      const reranked = reranker.rerank(results, "onboarding", "semantic_search");
      // Block should still rank first (higher similarity, no penalty in this preset)
      expect(reranked[0].payload?.chunkType).toBe("block");
    });
  });

  describe("confidence dampening for small sample sizes", () => {
    it("should dampen bugFixRate=100% on commitCount=1 vs reliable commitCount=10", () => {
      // Without dampening: bugFix signal = 100/100=1.0 vs 50/100=0.5 -> first wins
      // With quadratic dampening (k=8): 1.0*(1/8)^2~=0.016 vs 0.5*1.0=0.5 -> second wins
      const results = [
        createResult(0.8, 30, 1, false, { bugFixRate: 100 }),
        createResult(0.8, 30, 10, false, { bugFixRate: 50 }),
      ];
      const reranked = reranker.rerank(results, { custom: { bugFix: 1.0 } }, "semantic_search");
      expect(reranked[0].payload?.git?.commitCount).toBe(10);
    });

    it("should not dampen bugFix when commitCount >= 8 (bugFix threshold)", () => {
      const results = [
        createResult(0.8, 30, 10, false, { bugFixRate: 30 }),
        createResult(0.8, 30, 10, false, { bugFixRate: 80 }),
      ];
      const reranked = reranker.rerank(results, { custom: { bugFix: 1.0 } }, "semantic_search");
      expect(reranked[0].payload?.git?.bugFixRate).toBe(80);
    });

    it("should not dampen ownership when commitCount >= 5 (ownership threshold)", () => {
      const results = [
        createResult(0.8, 30, 6, false, { dominantAuthorPct: 30, authors: ["a", "b", "c", "d"] as any }),
        createResult(0.8, 30, 6, false, { dominantAuthorPct: 90, authors: ["alice", "bob"] as any }),
      ];
      const reranked = reranker.rerank(results, { custom: { ownership: 1.0 } }, "semantic_search");
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
      const reranked = reranker.rerank(results, { custom: { similarity: 0.5, bugFix: 0.5 } }, "semantic_search");
      // bugFix zeroed by confidence=0, similarity decides
      expect(reranked[0].payload?.relativePath).toBe("b.ts");
    });

    it("should NOT dampen recency (factual signal)", () => {
      // Both have commitCount=1. Recency is factual -- should NOT be dampened.
      // If recency were dampened, both would have ~0 recency and similarity would decide (tie).
      // If recency is NOT dampened, the recent file (ageDays=5) should win.
      const results = [
        createResult(0.8, 200, 1), // old, 1 commit
        createResult(0.8, 5, 1), // recent, 1 commit
      ];
      const reranked = reranker.rerank(results, { custom: { recency: 1.0 } }, "semantic_search");
      // Recent file must rank first -- recency not dampened
      expect(reranked[0].payload?.git?.ageDays).toBe(5);
    });

    it("should dampen ownership for single-commit chunks in hotspots", () => {
      // commitCount=1: inflated bugFixRate=100%, ownership trivially 100%
      // commitCount=10: moderate bugFixRate=40%, real ownership=80%
      // Hotspots uses bugFix and volatility which should be dampened
      const results = [
        createResult(0.8, 10, 1, false, {
          chunk: { commitCount: 1, churnRatio: 1.0 },
          recencyWeightedFreq: 1.0,
          bugFixRate: 100,
          churnVolatility: 30,
        }),
        createResult(0.8, 10, 10, false, {
          chunk: { commitCount: 8, churnRatio: 0.8 },
          recencyWeightedFreq: 5.0,
          bugFixRate: 40,
          churnVolatility: 20,
        }),
      ];
      const reranked = reranker.rerank(results, "hotspots", "semantic_search");
      expect(reranked[0].payload?.git?.commitCount).toBe(10);
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
      const results = reranker.rerank([moderateChurn, highChurn], "techDebt", "semantic_search");
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
      const results = reranker.rerank([a, b], "techDebt", "semantic_search");
      expect(results).toHaveLength(2);
      expect(results[0].score).toBeGreaterThanOrEqual(0);
      expect(results[1].score).toBeGreaterThanOrEqual(0);
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
      const reranked = reranker.rerank(results, "techDebt", "semantic_search");
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
      const reranked = reranker.rerank(results, "techDebt", "semantic_search");
      expect(reranked[0].payload?.git?.file?.ageDays).toBe(2000);
    });
  });

  describe("L3 alpha-blending", () => {
    it("should blend chunk and file bugFixRate based on alpha (low alpha -> effective ~= file value)", () => {
      // chunk.commitCount=1 in a 50-commit file -> alpha ~= 0.007 (very low)
      // So effective bugFixRate should be almost entirely file's value
      // Result A: file bugFix=80, chunk bugFix=10  -> effective ~= 80 (alpha low, file dominates)
      // Result B: file bugFix=20, chunk bugFix=90  -> effective ~= 20 (alpha low, file dominates)
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
      const reranked = reranker.rerank(results, { custom: { bugFix: 1.0 } }, "semantic_search");
      // File's bugFixRate=80 should dominate because alpha is tiny
      expect(reranked[0].payload?.relativePath).toBe("b.ts");
    });

    it("should give high alpha to chunk with many commits relative to file (8/10 -> alpha=0.8)", () => {
      // chunk.commitCount=8, file.commitCount=10 -> coverage=0.8, maturity=min(1,8/3)=1 -> alpha=0.8
      // Result A: file bugFix=20, chunk bugFix=90 -> effective = 0.8*90 + 0.2*20 = 76
      // Result B: file bugFix=80, chunk bugFix=10 -> effective = 0.8*10 + 0.2*80 = 24
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
      const reranked = reranker.rerank(results, { custom: { bugFix: 1.0 } }, "semantic_search");
      // With high alpha, chunk bugFix=90 dominates -> a.ts first
      expect(reranked[0].payload?.relativePath).toBe("a.ts");
    });

    it("should degenerate to file-only when chunk data absent (backward compat)", () => {
      // No chunk data -> alpha=0 -> effective = file value
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
      const reranked = reranker.rerank(results, { custom: { bugFix: 1.0 } }, "semantic_search");
      // Pure file-level: bugFixRate=80 > 20
      expect(reranked[0].payload?.relativePath).toBe("a.ts");
    });

    it("should set alpha=0 when chunk.commitCount=0", () => {
      // chunk.commitCount=0 -> alpha=0 -> file values used entirely
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
      const reranked = reranker.rerank(results, { custom: { bugFix: 1.0 } }, "semantic_search");
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

    it("should give continuous discount for blocks with partial chunk data (alpha=0.5 -> discount=0.5)", () => {
      // file.commitCount=10, chunk.commitCount=5 -> coverage=0.5, maturity=1.0 -> alpha=0.5
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
      const reranked = reranker.rerank(results, { custom: { similarity: 0.5, blockPenalty: -0.5 } }, "semantic_search");
      // Block gets partial discount (0.5), function gets 0. Function should rank higher.
      expect(reranked[0].payload?.chunkType).toBe("function");
      // But the gap should be smaller than full penalty
      expect(reranked[0].score - reranked[1].score).toBeLessThan(0.3);
    });

    it("should give full discount for blocks without chunk data (alpha=0 -> discount=1.0)", () => {
      // No chunk data -> alpha=0 -> discount=1.0 (full penalty, same as old behavior)
      const results = [createResultWithChunkType(0.8, "block", {}), createResultWithChunkType(0.8, "function", {})];
      const reranked = reranker.rerank(results, "hotspots", "semantic_search");
      // Function should rank higher -- block gets full discount
      expect(reranked[0].payload?.chunkType).toBe("function");
    });

    it("should give no discount for function/class chunks regardless of alpha", () => {
      // Even with no chunk data, function/class/interface never get discount
      const results = [
        createResultWithChunkType(0.8, "function", {}),
        createResultWithChunkType(0.8, "class", {}),
        createResultWithChunkType(0.8, "interface", {}),
      ];
      const reranked = reranker.rerank(results, "hotspots", "semantic_search");
      // All scores should be equal (no discount applied to any)
      expect(reranked[0].score).toBeCloseTo(reranked[1].score, 5);
      expect(reranked[1].score).toBeCloseTo(reranked[2].score, 5);
    });

    it("should give zero discount for blocks with rich chunk data (alpha=1.0)", () => {
      // chunk.commitCount=10, file.commitCount=10 -> coverage=1.0, maturity=1.0 -> alpha=1.0
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
      const reranked = reranker.rerank(
        results,
        { custom: { similarity: 0.5, chunkChurn: 0.3, blockPenalty: -0.3 } },
        "semantic_search",
      );
      // Block with alpha=1.0 gets discount=0.0 -> should score same as function
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
      const reranked = reranker.rerank(results, { custom: { burstActivity: 1.0 } }, "semantic_search");
      // Alpha=0.8 -> effective a.ts = 0.8*8.0+0.2*1.0=6.6, b.ts=0.8*1.0+0.2*8.0=2.4
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
      const reranked = reranker.rerank(results, { custom: { density: 1.0 } }, "semantic_search");
      // Alpha=0.8 -> effective a.ts = 0.8*15+0.2*1=12.2, b.ts=0.8*1+0.2*15=3.8
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
              // No chunk recencyWeightedFreq -> effectiveSignal returns file value
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
      const reranked = reranker.rerank(results, { custom: { burstActivity: 1.0 } }, "semantic_search");
      // Pure file values: 8.0 > 1.0 -> a.ts first
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
      const results = reranker.rerank([shared, silo], "techDebt", "semantic_search");
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
      const results = reranker.rerank([lowDensity, highDensity], "techDebt", "semantic_search");
      // High density (sustained change pressure) should rank higher
      expect(results[0].payload?.git?.file?.changeDensity).toBe(15);
    });
  });

  describe("edge cases", () => {
    it("should handle empty results", () => {
      const result = reranker.rerank([], "techDebt", "semantic_search");
      expect(result).toEqual([]);
    });

    it("should handle single result", () => {
      const single = [createResult(0.9, 10, 5)];
      const result = reranker.rerank(single, "techDebt", "semantic_search");
      expect(result).toHaveLength(1);
    });

    it("should handle results with missing payload", () => {
      const noPayload: RerankableResult[] = [{ score: 0.9 }, { score: 0.8 }];
      const result = reranker.rerank(noPayload, "techDebt", "semantic_search");
      expect(result).toHaveLength(2);
    });

    it("should handle unknown preset gracefully", () => {
      const result = reranker.rerank([createResult(0.9, 10, 5)], "unknownPreset" as any, "semantic_search");
      // Should fall back to relevance
      expect(result).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Reranker v2 class tests
// ---------------------------------------------------------------------------

describe("Reranker (v2 class)", () => {
  const reranker = new Reranker(allDescriptors, testPresets, testPayloadSignals);

  const makeResult = (
    score: number,
    git?: Record<string, unknown>,
    extra?: Partial<RerankableResult["payload"]>,
  ): RerankableResult => ({
    score,
    payload: { relativePath: "src/a.ts", startLine: 1, endLine: 50, ...extra, git },
  });

  it("returns results for relevance preset (no overlay)", () => {
    const results = [makeResult(0.9), makeResult(0.7)];
    const ranked = reranker.rerank(results, "relevance", "semantic_search");
    expect(ranked).toHaveLength(2);
    // relevance = similarity-only -> no reranking, no overlay
    expect(ranked[0].rankingOverlay).toBeUndefined();
  });

  it("reranks by techDebt preset with overlay", () => {
    const results = [
      makeResult(0.9, { file: { ageDays: 5, commitCount: 1 } }),
      makeResult(0.7, { file: { ageDays: 300, commitCount: 40 } }),
    ];
    const ranked = reranker.rerank(results, "techDebt", "semantic_search");
    // techDebt boosts old + high churn -> second result should rank higher
    expect(ranked[0].payload?.git).toBeDefined();
    // Overlay present
    expect(ranked[0].rankingOverlay).toBeDefined();
    expect(ranked[0].rankingOverlay!.preset).toBe("techDebt");
  });

  it("overlay contains only raw signals (no derived)", () => {
    const results = [makeResult(0.9, { file: { ageDays: 200, commitCount: 30, bugFixRate: 10 } })];
    const ranked = reranker.rerank(results, "techDebt", "semantic_search");
    const overlay = ranked[0].rankingOverlay!;
    // techDebt overlayMask has raw.file only — no derived
    expect(overlay).not.toHaveProperty("derived");
    expect(overlay.file).toBeDefined();
  });

  it("overlay contains raw file-level signals from descriptor sources", () => {
    const results = [makeResult(0.9, { file: { ageDays: 200, commitCount: 30 } })];
    const ranked = reranker.rerank(results, "techDebt", "semantic_search");
    const overlay = ranked[0].rankingOverlay!;
    // techDebt uses age (source: ageDays) and churn (source: commitCount)
    expect(overlay.file).toBeDefined();
    expect(overlay.file!.ageDays).toBe(200);
    expect(overlay.file!.commitCount).toBe(30);
  });

  it("overlay includes chunk-level raw signals when chunk data exists", () => {
    const results = [makeResult(0.8, { file: { commitCount: 20 }, chunk: { commitCount: 8, churnRatio: 0.4 } })];
    // hotspots uses chunkChurn (source: chunk.commitCount) and chunkRelativeChurn (source: chunk.churnRatio)
    const ranked = reranker.rerank(results, "hotspots", "semantic_search");
    const overlay = ranked[0].rankingOverlay!;
    expect(overlay.chunk).toBeDefined();
    expect(overlay.chunk!.commitCount).toBe(8);
    expect(overlay.chunk!.churnRatio).toBe(0.4);
  });

  it("overlay is undefined when preset has no non-similarity weights (relevance)", () => {
    const results = [makeResult(0.9, { file: { ageDays: 100, commitCount: 20, bugFixRate: 10 } })];
    const ranked = reranker.rerank(results, "relevance", "semantic_search");
    // relevance has similarity:1.0 only — no reranking, no overlay
    expect(ranked[0].rankingOverlay).toBeUndefined();
  });

  it("decomposition preset includes derived values in overlay", () => {
    const results = [
      makeResult(0.8, undefined, {
        contentSize: 5000,
        startLine: 1,
        endLine: 100,
        methodLines: 99,
        methodDensity: 50.5,
      }),
      makeResult(0.7, undefined, { contentSize: 500, startLine: 1, endLine: 10, methodLines: 9, methodDensity: 55.6 }),
    ];
    const ranked = reranker.rerank(results, "decomposition", "semantic_search");
    const overlay = ranked[0].rankingOverlay!;
    expect(overlay.preset).toBe("decomposition");
    expect(overlay.derived).toBeDefined();
    expect(overlay.derived!.chunkSize).toBeGreaterThan(0);
    expect(overlay.derived!.chunkDensity).toBeGreaterThan(0);
  });

  it("supports custom weights with overlay", () => {
    const results = [
      makeResult(0.5, undefined, { isDocumentation: true }),
      makeResult(0.9, undefined, { isDocumentation: false }),
    ];
    const ranked = reranker.rerank(results, { custom: { documentation: 1.0 } }, "semantic_search");
    expect(ranked[0].payload?.isDocumentation).toBe(true);
    expect(ranked[0].rankingOverlay!.preset).toBe("custom");
    // custom weights use fallback: extract raw sources for each active weight
    // documentation has sources: [] so no raw signals
    expect(ranked[0].rankingOverlay!).not.toHaveProperty("derived");
  });

  it("handles empty results", () => {
    const ranked = reranker.rerank([], "techDebt", "semantic_search");
    expect(ranked).toHaveLength(0);
  });

  it("handles single result", () => {
    const ranked = reranker.rerank([makeResult(0.8)], "techDebt", "semantic_search");
    expect(ranked).toHaveLength(1);
    expect(ranked[0].rankingOverlay).toBeDefined();
  });

  it("getPreset returns preset weights", () => {
    expect(reranker.getPreset("techDebt", "semantic_search")).toBeDefined();
    expect(reranker.getPreset("recent", "search_code")).toBeDefined();
    expect(reranker.getPreset("nonexistent", "semantic_search")).toBeUndefined();
  });

  it("getAvailablePresets returns preset names", () => {
    expect(reranker.getAvailablePresets("semantic_search")).toContain("techDebt");
    expect(reranker.getAvailablePresets("search_code")).toContain("recent");
  });

  it("getPresetDescriptions returns names with descriptions", () => {
    const descs = reranker.getPresetDescriptions("semantic_search");
    expect(descs.length).toBeGreaterThan(0);
    const techDebt = descs.find((d) => d.name === "techDebt");
    expect(techDebt).toBeDefined();
    expect(techDebt!.description).toBeTruthy();
  });

  it("search_code presets work", () => {
    const results = [makeResult(0.8, { file: { ageDays: 200 } }), makeResult(0.8, { file: { ageDays: 5 } })];
    const ranked = reranker.rerank(results, "recent", "search_code");
    expect(ranked[0].rankingOverlay!.preset).toBe("recent");
    expect(ranked[0].rankingOverlay!.file).toBeDefined();
    expect(ranked[0].rankingOverlay!.file!.ageDays).toBeDefined();
  });

  describe("confidence dampening via descriptors", () => {
    it("dampens bugFix for low commit counts (needsConfidence=true)", () => {
      // bugFix descriptor has needsConfidence=true, confidenceField="commitCount"
      // With commitCount=2, confidence = (2/8)^2 = 0.0625
      // bugFix raw = normalize(bugFixRate=100, 100) = 1.0
      // bugFix dampened = 1.0 * 0.0625 = 0.0625
      // Compare: same bugFixRate with low vs high commitCount
      const lowCC = [makeResult(0.5, { file: { commitCount: 2, bugFixRate: 100, ageDays: 100 } })];
      const highCC = [makeResult(0.5, { file: { commitCount: 20, bugFixRate: 100, ageDays: 100 } })];
      const rankedLow = reranker.rerank(lowCC, "techDebt", "semantic_search");
      const rankedHigh = reranker.rerank(highCC, "techDebt", "semantic_search");
      // Low commitCount should produce lower score due to dampening
      expect(rankedLow[0].score).toBeLessThan(rankedHigh[0].score);
    });

    it("does not dampen signals without needsConfidence (recency)", () => {
      // recency has needsConfidence=undefined -- no dampening
      // Same ageDays, different commitCount should yield same recency contribution
      const lowCC = [makeResult(0.5, { file: { ageDays: 182.5, commitCount: 1 } })];
      const highCC = [makeResult(0.5, { file: { ageDays: 182.5, commitCount: 20 } })];
      const rankedLow = reranker.rerank(lowCC, { custom: { recency: 1.0 } }, "semantic_search");
      const rankedHigh = reranker.rerank(highCC, { custom: { recency: 1.0 } }, "semantic_search");
      // recency = 1 - 182.5/365 = 0.5 regardless of commitCount
      expect(rankedLow[0].score).toBeCloseTo(rankedHigh[0].score, 2);
    });

    it("full confidence when commitCount exceeds threshold", () => {
      // bugFix: k=8, commitCount=10 -> confidence=(10/8)^2 capped at 1
      // vs commitCount=20 -> confidence also 1. Both should score the same.
      const cc10 = [makeResult(0.5, { file: { commitCount: 10, bugFixRate: 50, ageDays: 100 } })];
      const cc20 = [makeResult(0.5, { file: { commitCount: 20, bugFixRate: 50, ageDays: 100 } })];
      const ranked10 = reranker.rerank(cc10, { custom: { bugFix: 1.0 } }, "semantic_search");
      const ranked20 = reranker.rerank(cc20, { custom: { bugFix: 1.0 } }, "semantic_search");
      // Both above threshold -> same score
      expect(ranked10[0].score).toBeCloseTo(ranked20[0].score, 2);
    });
  });

  describe("adaptive bounds", () => {
    it("expands bounds when p95 exceeds default (prevents saturation)", () => {
      // Create results where ageDays >> defaultBound (365)
      // Without adaptive bounds: all would saturate at 1.0
      // With adaptive bounds: spread based on p95
      const results = [
        makeResult(0.5, { file: { ageDays: 1000, commitCount: 5 } }),
        makeResult(0.5, { file: { ageDays: 800, commitCount: 5 } }),
        makeResult(0.5, { file: { ageDays: 600, commitCount: 5 } }),
        makeResult(0.5, { file: { ageDays: 100, commitCount: 5 } }),
      ];
      const ranked = reranker.rerank(results, { custom: { age: 1.0 } }, "semantic_search");
      // With adaptive bounds, age=100 should NOT be ~0.27 (100/365) but ~0.1 (100/1000)
      // Find the result with ageDays=100
      const low = ranked.find((r) => r.payload?.git?.file?.ageDays === 100);
      const high = ranked.find((r) => r.payload?.git?.file?.ageDays === 1000);
      expect(low).toBeDefined();
      expect(high).toBeDefined();
      // High should rank higher (more age = higher score)
      expect(high!.score).toBeGreaterThan(low!.score);
      // Low age result should have meaningfully lower score than high
      // With static bounds: both 1000 and 800 saturate at 1.0
      // With adaptive: differentiation preserved
      expect(high!.score - low!.score).toBeGreaterThan(0.3);
    });
  });
});

// ---------------------------------------------------------------------------
// Reranker with resolvedPresets (DI)
// ---------------------------------------------------------------------------

describe("Reranker with resolvedPresets", () => {
  const customPreset: RerankPreset = {
    name: "myPreset",
    description: "Custom preset",
    tools: ["semantic_search"],
    weights: { similarity: 0.5, recency: 0.5 },
    overlayMask: { raw: { file: ["ageDays"] } },
  };

  const searchCodePreset: RerankPreset = {
    name: "fastFind",
    description: "Fast find preset",
    tools: ["search_code"],
    weights: { similarity: 0.8, recency: 0.2 },
    overlayMask: { raw: { file: ["ageDays"] } },
  };

  it("uses resolved presets when provided via getPreset()", () => {
    const reranker = new Reranker(allDescriptors, [customPreset]);
    expect(reranker.getPreset("myPreset", "semantic_search")).toEqual({ similarity: 0.5, recency: 0.5 });
  });

  it("getAvailablePresets returns resolved preset names", () => {
    const reranker = new Reranker(allDescriptors, [customPreset, searchCodePreset]);
    expect(reranker.getAvailablePresets("semantic_search")).toContain("myPreset");
    expect(reranker.getAvailablePresets("search_code")).toContain("fastFind");
  });

  it("getPresetNames returns resolved preset names", () => {
    const reranker = new Reranker(allDescriptors, [customPreset, searchCodePreset]);
    expect(reranker.getPresetNames("semantic_search")).toContain("myPreset");
    expect(reranker.getPresetNames("search_code")).toContain("fastFind");
  });

  it("getDescriptorInfo returns all descriptor info", () => {
    const reranker = new Reranker(allDescriptors, testPresets);
    const info = reranker.getDescriptorInfo();
    expect(info.length).toBeGreaterThan(0);
    expect(info[0]).toHaveProperty("name");
    expect(info[0]).toHaveProperty("description");
  });

  it("getPreset returns undefined for unknown preset", () => {
    const reranker = new Reranker(allDescriptors, [customPreset]);
    expect(reranker.getPreset("nonexistent", "semantic_search")).toBeUndefined();
  });

  it("rerank uses resolved preset weights", () => {
    const heavyRecency: RerankPreset = {
      name: "heavyRecency",
      description: "Heavy recency",
      tools: ["semantic_search"],
      weights: { similarity: 0.1, recency: 0.9 },
      overlayMask: { raw: { file: ["ageDays"] } },
    };
    const reranker = new Reranker(allDescriptors, [heavyRecency]);
    const results: RerankableResult[] = [
      {
        score: 0.9,
        payload: { relativePath: "old.ts", startLine: 1, endLine: 50, git: { file: { ageDays: 300, commitCount: 5 } } },
      },
      {
        score: 0.5,
        payload: { relativePath: "new.ts", startLine: 1, endLine: 50, git: { file: { ageDays: 5, commitCount: 5 } } },
      },
    ];
    const ranked = reranker.rerank(results, "heavyRecency", "semantic_search");
    // With 90% recency weight, recent file should rank first despite lower similarity
    expect(ranked[0].payload?.relativePath).toBe("new.ts");
  });
});

// ---------------------------------------------------------------------------
// PayloadSignalDescriptor-based Reranker (generic dot-notation traversal)
// ---------------------------------------------------------------------------

describe("Reranker with PayloadSignalDescriptor (generic payload reading)", () => {
  const testPayloadSignals = [
    { key: "git.file.ageDays", type: "number" as const, description: "Days since last modification" },
    { key: "git.file.commitCount", type: "number" as const, description: "Total commits" },
    { key: "git.file.bugFixRate", type: "number" as const, description: "Bug fix rate" },
    { key: "git.file.churnVolatility", type: "number" as const, description: "Churn volatility" },
    { key: "git.file.changeDensity", type: "number" as const, description: "Change density" },
    { key: "git.file.dominantAuthorPct", type: "number" as const, description: "Dominant author pct" },
    { key: "git.file.contributorCount", type: "number" as const, description: "Contributors" },
    { key: "git.file.relativeChurn", type: "number" as const, description: "Relative churn" },
    { key: "git.file.recencyWeightedFreq", type: "number" as const, description: "Recency freq" },
    { key: "git.chunk.commitCount", type: "number" as const, description: "Chunk commits" },
    { key: "git.chunk.churnRatio", type: "number" as const, description: "Chunk churn ratio" },
  ];

  const rerankerWithPayload = new Reranker(allDescriptors, testPresets, testPayloadSignals);

  const makeResult = (
    score: number,
    git?: Record<string, unknown>,
    extra?: Partial<RerankableResult["payload"]>,
  ): RerankableResult => ({
    score,
    payload: { relativePath: "src/a.ts", startLine: 1, endLine: 50, ...extra, git },
  });

  it("reads file-level raw signals via signalKeyMap for adaptive bounds", () => {
    const results = [
      makeResult(0.9, { file: { ageDays: 200, commitCount: 30 } }),
      makeResult(0.7, { file: { ageDays: 5, commitCount: 2 } }),
    ];
    // techDebt uses age + churn which need adaptive bounds from readRawSource
    const ranked = rerankerWithPayload.rerank(results, "techDebt", "semantic_search");
    expect(ranked[0].rankingOverlay).toBeDefined();
    expect(ranked[0].rankingOverlay!.preset).toBe("techDebt");
    // Overlay should contain raw file signals
    expect(ranked[0].rankingOverlay!.file).toBeDefined();
    expect(ranked[0].rankingOverlay!.file!.ageDays).toBeDefined();
    expect(ranked[0].rankingOverlay!.file!.commitCount).toBeDefined();
  });

  it("reads chunk-level raw signals via signalKeyMap for overlay", () => {
    const results = [makeResult(0.8, { file: { commitCount: 20 }, chunk: { commitCount: 8, churnRatio: 0.4 } })];
    const ranked = rerankerWithPayload.rerank(results, "hotspots", "semantic_search");
    const overlay = ranked[0].rankingOverlay!;
    expect(overlay.chunk).toBeDefined();
    expect(overlay.chunk!.commitCount).toBe(8);
    expect(overlay.chunk!.churnRatio).toBe(0.4);
  });

  it("resolves short name to full path for adaptive bounds", () => {
    // ageDays -> git.file.ageDays, commitCount -> git.file.commitCount
    // readRawSource("ageDays") should find value via signalKeyMap
    const results = [
      makeResult(0.9, { file: { ageDays: 100, commitCount: 10 } }),
      makeResult(0.8, { file: { ageDays: 300, commitCount: 50 } }),
    ];
    const ranked = rerankerWithPayload.rerank(results, "techDebt", "semantic_search");
    // Both should have overlays with actual raw values
    const firstOverlay = ranked[0].rankingOverlay!;
    expect(firstOverlay.file!.ageDays).toBeDefined();
    expect(typeof firstOverlay.file!.ageDays).toBe("number");
  });

  it("chunk.commitCount maps to git.chunk.commitCount (2-segment suffix)", () => {
    const results = [
      makeResult(0.8, {
        file: { commitCount: 20, bugFixRate: 10, churnVolatility: 5, recencyWeightedFreq: 3 },
        chunk: { commitCount: 15, churnRatio: 0.9 },
      }),
    ];
    const ranked = rerankerWithPayload.rerank(results, "hotspots", "semantic_search");
    const overlay = ranked[0].rankingOverlay!;
    expect(overlay.chunk!.commitCount).toBe(15);
  });

  it("falls back gracefully without payloadSignals (default empty)", () => {
    const rerankerNoPayload = new Reranker(allDescriptors, testPresets);
    const results = [makeResult(0.9, { file: { ageDays: 200 } })];
    // Should not crash, but readRawSource returns undefined for short names
    const ranked = rerankerNoPayload.rerank(results, "techDebt", "semantic_search");
    expect(ranked).toHaveLength(1);
  });

  it("supports non-git payload namespace via PayloadSignalDescriptor", () => {
    // Create a custom descriptor that reads from "metrics.file.responseTime"
    const customPayloadSignals = [
      { key: "metrics.file.responseTime", type: "number" as const, description: "Response time" },
    ];
    // Custom derived signal that uses "responseTime" as source
    const responseTimeSignal = {
      name: "responseTime",
      description: "Response time signal",
      sources: ["responseTime"],
      defaultBound: 5000,
      extract: (rawSignals: Record<string, unknown>) => {
        // Read from metrics.file.responseTime via payload
        const metrics = rawSignals.metrics as Record<string, unknown> | undefined;
        const file = metrics?.file as Record<string, unknown> | undefined;
        const val = file?.responseTime;
        return typeof val === "number" ? Math.min(val / 5000, 1) : 0;
      },
    };
    const customPreset: RerankPreset = {
      name: "slowEndpoints",
      description: "Slow endpoints",
      tools: ["semantic_search"],
      weights: { similarity: 0.3, responseTime: 0.7 },
      overlayMask: { file: ["responseTime"] },
    };
    const customReranker = new Reranker(
      [...allDescriptors, responseTimeSignal],
      [...testPresets, customPreset],
      customPayloadSignals,
    );
    const results: RerankableResult[] = [
      {
        score: 0.9,
        payload: { relativePath: "a.ts", startLine: 1, endLine: 10, metrics: { file: { responseTime: 100 } } },
      },
      {
        score: 0.7,
        payload: { relativePath: "b.ts", startLine: 1, endLine: 10, metrics: { file: { responseTime: 4000 } } },
      },
    ];
    const ranked = customReranker.rerank(results, "slowEndpoints", "semantic_search");
    // Overlay should contain the raw signal from non-git namespace
    expect(ranked[0].rankingOverlay!.file).toBeDefined();
    expect(ranked[0].rankingOverlay!.file!.responseTime).toBeDefined();
    expect(typeof ranked[0].rankingOverlay!.file!.responseTime).toBe("number");
  });
});

describe("Reranker — per-signal dampeningSource", () => {
  const payloadSignals: PayloadSignalDescriptor[] = [
    { key: "git.file.commitCount", type: "number", description: "Commits", stats: { percentiles: [25, 95] } },
    { key: "git.file.bugFixRate", type: "number", description: "Bug fix rate", stats: { percentiles: [95] } },
  ];

  // bugFix signal uses dampening (FALLBACK_THRESHOLD=8) and has dampeningSource
  const bugFixDescriptor = allDescriptors.filter((d) => d.name === "bugFix" || d.name === "similarity");
  const bugFixPreset: RerankPreset = {
    name: "bugFixOnly",
    description: "test",
    tools: ["semantic_search"],
    weights: { bugFix: 1.0 },
    overlayMask: {},
  };

  const makeResult = (score: number, git: Record<string, unknown>): RerankableResult => ({
    score,
    payload: { relativePath: "src/a.ts", startLine: 1, endLine: 50, git },
  });

  it("resolves dampeningThreshold per-signal from descriptor.dampeningSource", () => {
    const reranker = new Reranker(bugFixDescriptor, [bugFixPreset], payloadSignals);

    // Collection: commitCount p25=20
    const collectionStats: CollectionSignalStats = {
      perSignal: new Map([["git.file.commitCount", { count: 500, percentiles: { 25: 20, 95: 100 } }]]),
      computedAt: Date.now(),
    };
    reranker.setCollectionStats(collectionStats);

    // bugFix.dampeningSource = { key: "git.file.commitCount", percentile: 25 }
    // commitCount=4, dampeningThreshold=20 → dampening=(4/20)^2=0.04
    // bugFixRate=100, bound=100 → normalized=1.0, damped=0.04
    const results = [makeResult(0.9, { file: { bugFixRate: 100, commitCount: 4 } })];
    const ranked = reranker.rerank(results, "bugFixOnly", "semantic_search");

    expect(ranked[0].score).toBeLessThan(0.1);
  });

  it("falls back to per-signal FALLBACK_THRESHOLD when no collectionStats", () => {
    const reranker = new Reranker(bugFixDescriptor, [bugFixPreset], payloadSignals);
    // No setCollectionStats

    // commitCount=4, FALLBACK_THRESHOLD=8 → dampening=(4/8)^2=0.25
    const results = [makeResult(0.9, { file: { bugFixRate: 100, commitCount: 4 } })];
    const ranked = reranker.rerank(results, "bugFixOnly", "semantic_search");

    expect(ranked[0].score).toBeGreaterThan(0.15);
    expect(ranked[0].score).toBeLessThan(0.4);
  });

  it("signals without dampeningSource get no threshold (always use fallback)", () => {
    // similarity has no dampeningSource → always uses its own logic (no dampening)
    const simDescriptor = allDescriptors.filter((d) => d.name === "similarity");
    expect(simDescriptor[0].dampeningSource).toBeUndefined();
  });

  it("bugFix descriptor declares dampeningSource", () => {
    const bf = allDescriptors.find((d) => d.name === "bugFix")!;
    expect(bf.dampeningSource).toEqual({ key: "git.file.commitCount", percentile: 25 });
  });
});

describe("Reranker — collection-level p95 fallback for adaptive bounds", () => {
  const payloadSignals: PayloadSignalDescriptor[] = [
    { key: "git.file.ageDays", type: "number", description: "Age", stats: { percentiles: [95] } },
    { key: "git.file.commitCount", type: "number", description: "Commits", stats: { percentiles: [25, 95] } },
  ];

  // Minimal descriptor: only age signal, no dampening complexity
  const ageOnlyDescriptor = allDescriptors.filter((d) => d.name === "age" || d.name === "similarity");
  // Preset that only uses age (weight=1.0) to isolate bound effects
  const ageOnlyPreset: RerankPreset = {
    name: "ageOnly",
    description: "test",
    tools: ["semantic_search"],
    weights: { age: 1.0 },
  };

  const makeResult = (score: number, git: Record<string, unknown>): RerankableResult => ({
    score,
    payload: { relativePath: "src/a.ts", startLine: 1, endLine: 50, git },
  });

  it("uses collection-level p95 as floor instead of static defaultBound", () => {
    const reranker = new Reranker(ageOnlyDescriptor, [ageOnlyPreset], payloadSignals);

    // Collection p95=2000 (much larger than defaultBound=365)
    const collectionStats: CollectionSignalStats = {
      perSignal: new Map([["git.file.ageDays", { count: 1000, percentiles: { 95: 2000 } }]]),
      computedAt: Date.now(),
    };
    reranker.setCollectionStats(collectionStats);

    // Batch: ageDays=[100, 200] → batchP95≈200
    // Without collection stats: bound = max(200, 365) = 365 → age=200/365 ≈ 0.548
    // With collection stats:    bound = max(200, 2000) = 2000 → age=200/2000 = 0.10
    const results = [makeResult(0.9, { file: { ageDays: 200 } })];
    const ranked = reranker.rerank(results, "ageOnly", "semantic_search");

    // Score should be ~0.10 (collection p95=2000 as bound), not ~0.55 (defaultBound=365)
    expect(ranked[0].score).toBeLessThan(0.2);
  });

  it("does NOT use defaultBound as floor when collectionStats loaded (collP95 < defaultBound)", () => {
    const reranker = new Reranker(ageOnlyDescriptor, [ageOnlyPreset], payloadSignals);

    // Collection p95=15 (young codebase, much less than defaultBound=365)
    const collectionStats: CollectionSignalStats = {
      perSignal: new Map([["git.file.ageDays", { count: 100, percentiles: { 95: 15 } }]]),
      computedAt: Date.now(),
    };
    reranker.setCollectionStats(collectionStats);

    // Batch: ageDays=10 → batchP95=10
    // Current (defaultBound as floor): bound = max(10, 365) = 365 → age=10/365 = 0.027
    // Expected (adaptive):             bound = max(10, 15)  = 15  → age=10/15  = 0.667
    const results = [makeResult(0.9, { file: { ageDays: 10 } })];
    const ranked = reranker.rerank(results, "ageOnly", "semantic_search");

    // With adaptive bounds, age=10/15≈0.667. With static floor, age=10/365≈0.027.
    expect(ranked[0].score).toBeGreaterThan(0.5);
  });

  it("falls back to defaultBound when no collection stats exist", () => {
    const reranker = new Reranker(ageOnlyDescriptor, [ageOnlyPreset], payloadSignals);
    // No setCollectionStats

    // Batch: ageDays=[100, 200] → batchP95≈200
    // Bound = max(200, 365) = 365 → age=200/365 ≈ 0.548
    const results = [makeResult(0.9, { file: { ageDays: 200 } })];
    const ranked = reranker.rerank(results, "ageOnly", "semantic_search");

    // Score should be ~0.55 (defaultBound=365 as floor)
    expect(ranked[0].score).toBeGreaterThan(0.4);
    expect(ranked[0].score).toBeLessThan(0.7);
  });

  it("uses max(batchP95, collectionP95) — batch wins when larger", () => {
    const reranker = new Reranker(ageOnlyDescriptor, [ageOnlyPreset], payloadSignals);

    // Collection p95=50 (small codebase)
    const collectionStats: CollectionSignalStats = {
      perSignal: new Map([["git.file.ageDays", { count: 100, percentiles: { 95: 50 } }]]),
      computedAt: Date.now(),
    };
    reranker.setCollectionStats(collectionStats);

    // Batch: ageDays=[100, 800] → batchP95≈800
    // bound = max(800, 50) = 800 (batch wins over collection p95=50)
    // But also max(800, defaultBound=365) = 800 anyway
    // age=800/800 = 1.0
    const results = [makeResult(0.9, { file: { ageDays: 800 } })];
    const ranked = reranker.rerank(results, "ageOnly", "semantic_search");

    // Score should be ~1.0 (batch p95 dominates)
    expect(ranked[0].score).toBeGreaterThan(0.8);
  });
});

describe("signalLevel: file-level preset suppresses chunk overlay", () => {
  const reranker = new Reranker(allDescriptors, testPresets, testPayloadSignals);

  it("ownership (file-level preset) should not include chunk in overlay", () => {
    const results: RerankableResult[] = [
      {
        score: 0.8,
        payload: {
          relativePath: "src/auth.ts",
          startLine: 1,
          endLine: 50,
          language: "typescript",
          git: {
            file: { ageDays: 30, commitCount: 10, dominantAuthorPct: 90, contributorCount: 2 },
            chunk: { contributorCount: 1, commitCount: 8 },
          },
        },
      },
    ];
    const reranked = reranker.rerank(results, "ownership", "semantic_search");
    expect(reranked[0].rankingOverlay).toBeDefined();
    expect(reranked[0].rankingOverlay!.chunk).toBeUndefined();
    expect(reranked[0].rankingOverlay!.file).toBeDefined();
  });

  it("hotspots (chunk-level preset) should include chunk in overlay", () => {
    const results: RerankableResult[] = [
      {
        score: 0.8,
        payload: {
          relativePath: "src/hot.ts",
          startLine: 1,
          endLine: 50,
          language: "typescript",
          git: {
            file: { ageDays: 5, commitCount: 20, recencyWeightedFreq: 8, changeDensity: 15 },
            chunk: { commitCount: 15, churnRatio: 0.8 },
          },
        },
      },
    ];
    const reranked = reranker.rerank(results, "hotspots", "semantic_search");
    expect(reranked[0].rankingOverlay).toBeDefined();
    expect(reranked[0].rankingOverlay!.chunk).toBeDefined();
  });

  it("overrideSignalLevel=file should suppress chunk overlay even for chunk-level preset", () => {
    const results: RerankableResult[] = [
      {
        score: 0.8,
        payload: {
          relativePath: "src/hot.ts",
          startLine: 1,
          endLine: 50,
          language: "typescript",
          git: {
            file: { ageDays: 5, commitCount: 20, recencyWeightedFreq: 8, changeDensity: 15 },
            chunk: { commitCount: 15 },
          },
        },
      },
    ];
    const reranked = reranker.rerank(results, "hotspots", "semantic_search", "file");
    expect(reranked[0].rankingOverlay).toBeDefined();
    expect(reranked[0].rankingOverlay!.chunk).toBeUndefined();
  });
});
