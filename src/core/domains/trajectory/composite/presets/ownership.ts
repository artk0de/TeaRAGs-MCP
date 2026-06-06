import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { CompositeRerankPreset, OverlayMask, SignalLevel } from "../../../../contracts/types/reranker.js";

/**
 * Composite override for `ownership` — fanIn amplifies bus-factor risk.
 * A silo-owned utility nobody calls is fine to leave alone; a silo-owned
 * file that's imported by 50 modules is the urgent knowledge-transfer
 * target. fanIn weight surfaces that distinction at rank time.
 */
export class OwnershipCompositePreset implements CompositeRerankPreset {
  readonly name = "ownership";
  readonly description = "Silo-owned code that other files depend on — prioritised bus-factor target";
  readonly signalLevel: SignalLevel = "file";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar", "trace_path"];
  readonly requires = ["codegraph.symbols", "git"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.3,
    ownership: 0.3,
    knowledgeSilo: 0.2,
    fanIn: 0.1,
    chunkChurn: 0.1,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "blameDominantAuthorPct",
      "blameContributorCount",
      "recentDominantAuthorPct",
      "recentContributorCount",
      "codegraph.file.fanIn",
    ],
    chunk: ["blameDominantAuthorPct", "blameContributorCount", "recentContributorCount", "commitCount"],
  };
}
