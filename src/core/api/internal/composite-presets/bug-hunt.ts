import {
  CODEGRAPH_SYMBOLS_PROVIDER_KEY,
  type CompositeRerankPreset,
  type OverlayMask,
  type ScoringWeights,
  type SignalLevel,
} from "../../../contracts/index.js";

/**
 * Composite override for `bugHunt` — the git preset's temporal reading of a
 * codebase plus one call-graph term.
 *
 * The git variant already answers "where are bugs hiding" from history alone:
 * commit churn, bug-fix rate, change density, recency and burst activity, with
 * weights calibrated by a git backtest (see `BugHuntPreset`). What it cannot
 * see is that two equally bug-prone methods are not equally worth looking at —
 * the one the rest of the graph routes through is. `pageRank` at 0.14 supplies
 * that tie-break without displacing the process signals, which stay dominant
 * per Yatish et al. 2020 (ICSME): process metrics beat product metrics for
 * defect proneness, AUC 95% vs 54%. The git share (0.66) keeps the calibrated
 * git-preset proportions; pageRank 0.14 is unchanged and NOT calibrated, since
 * there is no historical call graph to backtest against.
 *
 * Two things are carried over from the current git base rather than from the
 * original design note, which predates both: `trace_path` in `tools` (a partial
 * override would leave the git preset winning on that one tool, so the same
 * name would mean different weights depending on which tool you called) and
 * `blockPenalty` in the weights.
 *
 * Override mechanism: shares `(name, tools)` with the git trajectory's
 * `BugHuntPreset`, so `resolvePresets(registry, composite)` picks this one
 * whenever codegraph is wired and falls back to the git preset when it is not.
 * The git file stays untouched.
 */
export class BugHuntCompositePreset implements CompositeRerankPreset {
  readonly name = "bugHunt";
  readonly filter = { presets: "production" } as const;
  readonly signalLevel: SignalLevel = "file";
  readonly description =
    "Find potential bug hiding spots: commit churn, bug fix history, change density, recency, burst activity, and call-graph centrality";
  readonly tools = ["semantic_search", "hybrid_search", "search_code", "find_similar", "rank_chunks", "trace_path"];
  readonly requires = [CODEGRAPH_SYMBOLS_PROVIDER_KEY, "git"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    churn: 0.22,
    bugFix: 0.18,
    pageRank: 0.14,
    density: 0.13,
    recency: 0.09,
    burstActivity: 0.04,
    blockPenalty: -0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "bugFixRate",
      "commitCount",
      "changeDensity",
      "churnVolatility",
      "recencyWeightedFreq",
      "relativeChurn",
      "ageDays",
      "imports",
      "recentDominantAuthorPct",
      "blameDominantAuthorPct",
      "recentContributorCount",
    ],
    chunk: [
      "commitCount",
      "churnRatio",
      "bugFixRate",
      "ageDays",
      "relativeChurn",
      "recentContributorCount",
      "codegraph.chunk.pageRank",
      "codegraph.chunk.fanIn",
      "codegraph.chunk.fanOut",
    ],
  };
}
