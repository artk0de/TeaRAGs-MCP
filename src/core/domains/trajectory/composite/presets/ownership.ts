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
  // chunkChurn dropped (signalLevel "file" → payloadAlpha 0 → always-0 dead
  // weight). Mirrors the git ownership redistribution: ownership +0.05,
  // knowledgeSilo +0.05; fanIn (the composite's blast-radius axis) stays 0.1.
  readonly weights: ScoringWeights = {
    similarity: 0.3,
    ownership: 0.35,
    knowledgeSilo: 0.25,
    fanIn: 0.1,
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
