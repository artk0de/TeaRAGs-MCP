import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { CompositeRerankPreset, OverlayMask, SignalLevel } from "../../../../contracts/types/reranker.js";

/**
 * Composite override for `godModule` — the file axis of structural debt,
 * with the call graph folded in.
 *
 * Symbol mass stays dominant at 0.5, because that is what defines a god
 * module; demoting it would turn this into a second `architecturalHub`. The
 * three structural signals (0.35 combined) amplify the mass ranking by how
 * deeply the file is wired in — mass × blast radius is what separates "big
 * file nobody depends on" from "big file everything runs through".
 *
 * No new derived signals: `fanIn`, `transitiveImpact` and `isHub` already
 * ship with the codegraph trajectory. Collections without codegraph resolve
 * the static, mass-only variant unchanged.
 */
export class GodModuleCompositePreset implements CompositeRerankPreset {
  readonly name = "godModule";
  readonly description = "Files carrying too much interface mass, weighted by how deeply they are wired in";
  readonly signalLevel: SignalLevel = "file";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly requires = ["codegraph.symbols"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.15,
    symbolCount: 0.5,
    fanIn: 0.15,
    transitiveImpact: 0.1,
    isHub: 0.1,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "fileSymbolCount",
      "codegraph.file.fanIn",
      "codegraph.file.fanOut",
      "codegraph.file.transitiveImpact",
      "codegraph.file.isHub",
    ],
    chunk: ["memberCount", "classLines"],
  };
}
