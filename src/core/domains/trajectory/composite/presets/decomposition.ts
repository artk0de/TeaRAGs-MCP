import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { CompositeRerankPreset, OverlayMask, SignalLevel } from "../../../../contracts/types/reranker.js";

/**
 * Composite override for `decomposition` — the method axis of structural
 * debt. The static variant scores size and density alone, which misses the
 * method that is merely long-ish but orchestrates a dozen collaborators.
 * `codegraph.chunk.fanOut` is exactly that signal: its calibrated p95 label
 * is literally `god-method`, and until now no preset weighted it.
 *
 * The score answers "what should be split" — size × density × outgoing load.
 * `fanIn` and `pageRank` answer a different question, "what does it cost to
 * touch this / how important is it", so they ride the overlay and feed the
 * consumer's fix-cost classifier instead of the score. Folding them in would
 * conflate detection with prioritisation — the same argument that keeps
 * `instability` out of `architecturalHub`'s weights (Santos 2017).
 *
 * `groupBy: "parentSymbolId"` is preserved from the static preset so
 * rank_chunks still reports one row per owning class.
 */
export class DecompositionCompositePreset implements CompositeRerankPreset {
  readonly name = "decomposition";
  readonly description = "Large, dense, over-connected methods — decomposition candidates ranked with call-graph load";
  readonly signalLevel: SignalLevel = "chunk";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly requires = ["codegraph.symbols"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    chunkSize: 0.35,
    chunkFanOut: 0.3,
    chunkDensity: 0.15,
  };
  readonly overlayMask: OverlayMask = {
    chunk: ["codegraph.chunk.fanOut", "codegraph.chunk.fanIn", "codegraph.chunk.pageRank"],
    file: ["methodLines", "codegraph.file.transitiveImpact"],
  };
  readonly groupBy = "parentSymbolId";
}
