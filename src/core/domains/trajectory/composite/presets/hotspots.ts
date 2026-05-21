import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { CompositeRerankPreset, OverlayMask } from "../../../../contracts/types/reranker.js";

/**
 * Composite override for `hotspots` — adds codegraph `fanIn` exposure so
 * a high-churn method that's also heavily depended on (architectural
 * hotspot) ranks above an isolated noisy chunk. Weights kept modest per
 * Yatish 2020 — process metrics still dominate.
 *
 * Override mechanism: shares (name, tools) with the git trajectory's
 * `HotspotsPreset`; `resolvePresets(registry, composite)` picks this
 * one as the second-pass winner whenever codegraph is wired. Trajectory
 * file stays untouched.
 */
export class HotspotsCompositePreset implements CompositeRerankPreset {
  readonly name = "hotspots";
  readonly description =
    "Surface frequently-changing code areas with structural awareness (chunk churn + dependency fanIn)";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly requires = ["codegraph.symbols", "git"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.18,
    chunkSize: 0.1,
    chunkChurn: 0.15,
    chunkRelativeChurn: 0.15,
    burstActivity: 0.12,
    bugFix: 0.1,
    volatility: 0.12,
    fanIn: 0.08,
    blockPenalty: -0.15,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "bugFixRate",
      "churnVolatility",
      "recencyWeightedFreq",
      "ageDays",
      "relativeChurn",
      "imports",
      "recentDominantAuthorPct",
      "blameDominantAuthorPct",
      "recentContributorCount",
      "codegraph.file.fanIn",
    ],
    chunk: ["commitCount", "churnRatio", "bugFixRate", "ageDays", "relativeChurn", "recentContributorCount"],
  };
}
