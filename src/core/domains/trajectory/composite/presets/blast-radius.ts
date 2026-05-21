import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { CompositeRerankPreset, OverlayMask } from "../../../../contracts/types/reranker.js";

/**
 * Blast-radius composite preset — combines codegraph fan-graph signals
 * with the git `churn` weight. Lives in the composite trajectory namespace
 * because it spans two trajectories; replaces the Slice 1 placement under
 * `codegraph/symbols/rerank/presets/` (mis-categorised: a preset that
 * reaches into git is not a codegraph trajectory preset).
 *
 * Weights retuned to align with Yatish 2020 — process metrics dominate
 * product metrics (AUC 95% vs 54%). Original Slice 1 placement weighted
 * structural signals (`fanIn` + `isHub` + `instability`) at 0.55 with
 * `churn` at 0.1; the retune flips this to process-leading
 * (`churn` 0.2 + `bugFix` 0.15 = 0.35) while keeping `fanIn` 0.3 as the
 * primary blast-radius proxy.
 *
 * Sources:
 * - Yatish et al. 2020 (ICSME) — process > product
 * - Santos 2017 — `instability` rejected as standalone preset (skewed
 *   distribution, no discrimination); kept here as overlay signal only.
 */
export class BlastRadiusPreset implements CompositeRerankPreset {
  readonly name = "blastRadius";
  readonly description = "Rank by blast radius — fanIn + churn dominant, structural overlays expose hub-ness";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks"];
  readonly requires = ["codegraph.symbols", "git"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    fanIn: 0.3,
    churn: 0.2,
    bugFix: 0.15,
    isHub: 0.1,
    chunkFanIn: 0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: ["codegraph.file.fanIn", "codegraph.file.fanOut", "codegraph.file.instability", "codegraph.file.isHub"],
    chunk: ["codegraph.chunk.fanIn", "codegraph.chunk.fanOut"],
  };
}
