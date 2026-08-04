import type { ScoringWeights } from "../../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset, SignalLevel } from "../../../../../../contracts/types/reranker.js";

/**
 * `hotMethod` — direct call popularity, straight off `codegraph.chunk.fanIn`.
 *
 * A method with many callers is the project's de-facto API whether or not
 * anyone declared it one: change its signature and every one of those call
 * sites has to move with it. That makes fanIn the cost-to-TOUCH number, and it
 * drives concrete decisions — where test coverage buys the most, what a
 * deprecation has to schedule, which methods a newcomer should read first.
 *
 * Deliberately contrasted with `criticalMethod`: same call graph, different
 * question. fanIn counts who breaks NOW; PageRank measures how deep a change
 * RIPPLES. A widely-called leaf scores high here and low there; a quiet center
 * on the main execution path does the reverse.
 *
 * `signalLevel: "chunk"` — fanIn is per-method, and file-level aggregation
 * would report one representative chunk's callers as the file's.
 */
export class HotMethodPreset implements RerankPreset {
  readonly name = "hotMethod";
  readonly description = "Methods everything calls — raw incoming call count, the de-facto method-level API";
  readonly signalLevel: SignalLevel = "chunk";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.3,
    chunkFanIn: 0.7,
  };
  readonly overlayMask: OverlayMask = {
    chunk: ["codegraph.chunk.fanIn", "codegraph.chunk.fanOut", "codegraph.chunk.pageRank"],
  };
}
