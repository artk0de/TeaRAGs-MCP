import type { ScoringWeights } from "../../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset, SignalLevel } from "../../../../../../contracts/types/reranker.js";

/**
 * `criticalMethod` — transitive importance over the method call graph.
 *
 * PageRank weights a method by the importance of its callers rather than their
 * count, so it surfaces the "quiet centers": a helper with a modest fanIn that
 * nonetheless sits on the execution path of everything that matters. Raw fanIn
 * cannot see those — that is `hotMethod`'s axis, and the pair splits the
 * question deliberately: `hotMethod` answers how costly a method is to TOUCH
 * (direct callers break), `criticalMethod` answers how deep a change RIPPLES.
 *
 * Use it to prioritise code review and to size change risk before editing.
 *
 * `signalLevel: "chunk"` is load-bearing. PageRank is a per-method number;
 * file-level presets aggregate through `groupByFile`, which attaches the
 * payload of ONE representative chunk to the file row and would report a random
 * method's centrality as the file's.
 *
 * fanIn and fanOut ride the overlay rather than the score — they answer the
 * neighbouring question ("who calls this, what does it call") and belong in the
 * explanation, not in the ranking.
 */
export class CriticalMethodPreset implements RerankPreset {
  readonly name = "criticalMethod";
  readonly description = "Methods the call graph depends on transitively — PageRank centrality, not raw call count";
  readonly signalLevel: SignalLevel = "chunk";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.3,
    pageRank: 0.7,
  };
  readonly overlayMask: OverlayMask = {
    chunk: ["codegraph.chunk.pageRank", "codegraph.chunk.fanIn", "codegraph.chunk.fanOut"],
  };
}
