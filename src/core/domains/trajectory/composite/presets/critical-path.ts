import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { CompositeRerankPreset, OverlayMask, SignalLevel } from "../../../../contracts/types/reranker.js";

/**
 * `criticalPath` — the QA lens: methods that are central in the call graph AND
 * historically unstable. Neither half is interesting alone. A central method
 * nobody has had to fix is fine; a churny method nothing depends on breaks in
 * isolation. The intersection is where a regression is most expensive, which is
 * what a pre-release test pass wants ranked first.
 *
 * Weights follow Yatish et al. 2020 (ICSME) — process metrics beat product
 * metrics for defect proneness (AUC 95% vs 54%), so `bugFix` + `churn` = 0.5
 * leads `pageRank` at 0.3. PageRank rather than fanIn on purpose: the cost of a
 * regression is how far it propagates, not how many call sites touch it
 * directly (that axis belongs to `hotMethod`).
 *
 * `filter: { presets: "production" }` mirrors `BlastRadiusPreset`. Test files
 * carry noisy churn and bugFix histories — they are edited alongside every fix
 * they cover — and would crowd out the production methods this ranking exists
 * to surface.
 *
 * `signalLevel: "chunk"`: PageRank is a per-method number, and file-level
 * aggregation would attribute one representative chunk's centrality to the
 * whole file.
 */
export class CriticalPathPreset implements CompositeRerankPreset {
  readonly name = "criticalPath";
  readonly description = "Where a regression costs most — central methods with unstable history (pageRank + bugFix)";
  readonly signalLevel: SignalLevel = "chunk";
  readonly filter = { presets: "production" } as const;
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly requires = ["codegraph.symbols", "git"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    pageRank: 0.3,
    bugFix: 0.3,
    churn: 0.2,
  };
  readonly overlayMask: OverlayMask = {
    chunk: ["codegraph.chunk.pageRank", "codegraph.chunk.fanIn", "codegraph.chunk.fanOut", "bugFixRate", "commitCount"],
  };
}
