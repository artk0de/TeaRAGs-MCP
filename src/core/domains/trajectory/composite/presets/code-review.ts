import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { CompositeRerankPreset, OverlayMask } from "../../../../contracts/types/reranker.js";

/**
 * Composite override for `codeReview` — recently-changed files that
 * are heavily depended on warrant senior review even if the diff looks
 * small. fanIn moves them up the queue.
 */
export class CodeReviewCompositePreset implements CompositeRerankPreset {
  readonly name = "codeReview";
  readonly description = "Recent high-activity code, prioritised by blast radius";
  readonly tools = ["semantic_search", "hybrid_search", "find_similar", "rank_chunks", "trace_path"];
  readonly requires = ["codegraph.symbols", "git"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.27,
    recency: 0.13,
    burstActivity: 0.1,
    density: 0.08,
    chunkChurn: 0.13,
    chunkRelativeChurn: 0.09,
    recentActivityConcentration: 0.13,
    fanIn: 0.07,
    blockPenalty: -0.1,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "ageDays",
      "recencyWeightedFreq",
      "changeDensity",
      "recentDominantAuthorPct",
      "blameDominantAuthorPct",
      "codegraph.file.fanIn",
    ],
    chunk: ["commitCount", "churnRatio"],
  };
}
