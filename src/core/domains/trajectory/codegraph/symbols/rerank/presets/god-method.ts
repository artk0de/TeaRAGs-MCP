import type { ScoringWeights } from "../../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset, SignalLevel } from "../../../../../../contracts/types/reranker.js";

/**
 * `godMethod` — outgoing-call overload, straight off `codegraph.chunk.fanOut`.
 *
 * A method that calls a dozen collaborators is orchestrating, not doing one
 * thing; the calibrated p95 label on `codegraph.chunk.fanOut` is literally
 * `god-method`. Ranked this way the list reads as a queue of SRP violations and
 * extract-method candidates.
 *
 * The mirror of `hotMethod`: same graph, opposite direction. fanIn asks who
 * depends on this method, fanOut asks how much this method depends on. High on
 * both is the orchestrator everyone routes through — the pair of overlays makes
 * that visible without either preset having to score the other's axis.
 *
 * Related but distinct from the `decomposition` composite, which weights size
 * and density alongside fanOut. This one isolates the call-graph axis: a short
 * method with fifteen outgoing calls surfaces here and stays buried there.
 *
 * `signalLevel: "chunk"` — fanOut is per-method, and file-level aggregation
 * would report one representative chunk's outgoing load as the file's.
 */
export class GodMethodPreset implements RerankPreset {
  readonly name = "godMethod";
  readonly description = "Methods that call too much — outgoing-call overload, orchestrators and SRP violations";
  readonly signalLevel: SignalLevel = "chunk";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.3,
    chunkFanOut: 0.7,
  };
  readonly overlayMask: OverlayMask = {
    chunk: ["codegraph.chunk.fanOut", "codegraph.chunk.fanIn", "codegraph.chunk.pageRank"],
  };
}
