import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { CompositeRerankPreset, OverlayMask, SignalLevel } from "../../../../contracts/types/reranker.js";

/**
 * `architecturalHub` — files at the centre of the dependency graph
 * that move under sustained churn. These are the most expensive places
 * for a regression to land: many consumers (high fanIn), many outgoing
 * dependencies (high fanOut → the `isHub` raw signal flips when both
 * exceed cohort p95), and active modification (churn). Pure codegraph
 * gives the structure; git churn confirms the file is alive and at risk.
 *
 * Per Santos 2017 (skewed Martin instability distribution), the
 * `instability` signal is intentionally NOT used as a primary weight
 * here — `isHub` provides the discriminative signal instead and the
 * raw `codegraph.file.instability` overlay still surfaces in the
 * ranking overlay for human interpretation.
 */
export class ArchitecturalHubPreset implements CompositeRerankPreset {
  readonly name = "architecturalHub";
  readonly description = "Hub files at the centre of the dependency graph under active churn";
  readonly signalLevel: SignalLevel = "file";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar", "trace_path"];
  readonly requires = ["codegraph.symbols", "git"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    isHub: 0.35,
    fanIn: 0.2,
    fanOut: 0.1,
    churn: 0.1,
    bugFix: 0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "codegraph.file.fanIn",
      "codegraph.file.fanOut",
      "codegraph.file.isHub",
      "codegraph.file.instability",
      "commitCount",
      "bugFixRate",
    ],
    chunk: ["codegraph.chunk.fanIn", "codegraph.chunk.fanOut"],
  };
}
