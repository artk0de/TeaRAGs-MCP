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
 * `churn` at 0.1; the retune flipped this to process-leading
 * (`churn` 0.2 + `bugFix` 0.15 = 0.35).
 *
 * `transitiveImpact` leads the structural half, because blast radius IS
 * transitive reach. `codegraph.file.transitiveImpact` counts the distinct
 * files that reach this one at any depth (reverse BFS, depth-capped at index
 * time); `fanIn` counts only the files that import it directly, so it is that
 * same measurement truncated at depth 1. `CriticalPathPreset` already makes
 * this argument for the method-level axis — "the cost of a regression is how
 * far it propagates, not how many call sites touch it directly" — and a preset
 * NAMED for blast radius cannot disagree with it.
 *
 * The 0.2 is paid for entirely out of the ONE-HOP structural budget
 * (`fanIn` 0.3 -> 0.15, `isHub` 0.1 -> 0.05), never out of the process budget:
 * `churn` + `bugFix` stay at 0.35, per Yatish. `fanIn` is kept, at half, as the
 * high-confidence floor — the transitive count is depth-capped and reads 0 on
 * files whose imports the graph failed to resolve, where direct fan-in still
 * holds. `isHub` is the same one-hop axis binarised at cohort p95, so it
 * double-counts once transitive reach carries the signal; 0.05 leaves it as a
 * tie-breaker. Net effect: no product metric now outranks the leading process
 * metric, which the old `fanIn` 0.3 > `churn` 0.2 arrangement contradicted.
 *
 * `pageRank` is deliberately absent. It is the method-level analogue and reads
 * `codegraph.chunk.pageRank` — one representative chunk's centrality, which
 * does not describe the file's reach. That is the mistake `ownership` and
 * `securityAudit` document backing out of for `chunkChurn`.
 *
 * Sources:
 * - Yatish et al. 2020 (ICSME) — process > product
 * - Santos 2017 — `instability` rejected as standalone preset (skewed
 *   distribution, no discrimination); kept here as overlay signal only.
 */
export class BlastRadiusPreset implements CompositeRerankPreset {
  readonly name = "blastRadius";
  readonly filter = { presets: "production" } as const;
  readonly description =
    "Rank by blast radius — transitive reach + churn dominant, structural overlays expose hub-ness";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "trace_path"];
  readonly requires = ["codegraph.symbols", "git"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    transitiveImpact: 0.2,
    fanIn: 0.15,
    churn: 0.2,
    bugFix: 0.15,
    isHub: 0.05,
    chunkFanIn: 0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "codegraph.file.transitiveImpact",
      "codegraph.file.fanIn",
      "codegraph.file.fanOut",
      "codegraph.file.instability",
      "codegraph.file.isHub",
    ],
    chunk: ["codegraph.chunk.fanIn", "codegraph.chunk.fanOut"],
  };
}
