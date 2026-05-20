import type { ScoringWeights } from "../../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../../contracts/types/reranker.js";

/**
 * Blast-radius preset — rank chunks by how widely they are depended on.
 *
 * Combines:
 *   - 25% similarity — keep query relevance modest so structural signals win
 *   - 25% fanIn (file-level) — files imported by many others sit higher
 *   - 15% instability — Martin instability surfaces high-fanOut leaves
 *   - 15% isHub — boolean flag for cohort-p95 hubs
 *   - 10% churn — borrowed from git trajectory for "recently touched + hub" risk
 *   - 10% chunkFanIn (method-level) — symbols called from many sites
 */
export class BlastRadiusPreset implements RerankPreset {
  readonly name = "blastRadius";
  readonly description = "Rank by blast radius — files imported by many others ranked higher, similarity stays modest";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks"];
  readonly weights: ScoringWeights = {
    similarity: 0.25,
    fanIn: 0.25,
    instability: 0.15,
    isHub: 0.15,
    churn: 0.1,
    chunkFanIn: 0.1,
  };
  readonly overlayMask: OverlayMask = {
    file: ["codegraph.file.fanIn", "codegraph.file.fanOut", "codegraph.file.instability", "codegraph.file.isHub"],
    chunk: ["codegraph.chunk.fanIn", "codegraph.chunk.fanOut"],
  };
}
