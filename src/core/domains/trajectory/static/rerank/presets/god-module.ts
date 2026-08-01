import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset, SignalLevel } from "../../../../../contracts/types/reranker.js";

/**
 * Find files carrying too much interface mass — god modules and god classes.
 *
 * Use when: hunting the files that accumulated everything, planning a split,
 *   auditing which modules own an outsized share of the project's symbols.
 * Query examples: "request handling", "user model", "indexing pipeline".
 * Key signals: symbolCount (distinct code symbols declared in the file).
 *   Similarity stays at 0.2 so a broad query still ranks by mass.
 *
 * `signalLevel: "file"` — the score is about the file, not the chunk that
 * happened to match. The overlay then carries the numbers that decide the
 * verdict: a dominant class holding most of the file's members is a god
 * CLASS, a spread of top-level symbols with no dominant class is a god
 * MODULE. The preset name tracks the ranking granularity, not the verdict.
 *
 * Call-graph signals are deliberately absent: fanIn and pageRank measure
 * connectivity, not mass, and this preset must work on collections with no
 * call graph. The composite variant (gated on `codegraph.symbols`) folds
 * connectivity back in as an amplifier.
 */
export class GodModulePreset implements RerankPreset {
  readonly name = "godModule";
  readonly description = "Find files carrying too much interface mass — god modules and god classes";
  readonly signalLevel: SignalLevel = "file";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    symbolCount: 0.8,
  };
  readonly overlayMask: OverlayMask = {
    file: ["fileSymbolCount"],
    chunk: ["memberCount", "classLines"],
  };
}
