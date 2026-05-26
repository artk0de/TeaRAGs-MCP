import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../../infra/signal-utils.js";
import { codegraphChunkNum } from "./helpers.js";

/**
 * Method-level PageRank — captures recursive importance. A utility
 * called by many high-rank methods inherits weight even when its
 * direct fanIn is modest, so PageRank surfaces "the symbol everyone
 * eventually depends on" while fanIn only sees direct callers.
 *
 * Raw `codegraph.chunk.pageRank` is normalized to roughly [0, ~0.05]
 * on realistic codebases (sum ≈ 1, distributed across thousands of
 * symbols). The default bound 0.01 scales typical "high importance"
 * symbols to the 0.5–1.0 derived range; collection-stats p95
 * overrides via bounds["chunk.pageRank"] tighten it per-codebase.
 */
export class PageRankSignal implements DerivedSignalDescriptor {
  readonly name = "pageRank";
  readonly description = "Normalized PageRank over the method call graph (recursive importance)";
  readonly sources = ["codegraph.chunk.pageRank"];
  readonly defaultBound = 0.01;
  extract(raw: Record<string, unknown>, ctx?: ExtractContext): number {
    const v = codegraphChunkNum(raw, "pageRank");
    const bound = ctx?.bounds?.["chunk.pageRank"] ?? this.defaultBound;
    return normalize(v, bound);
  }
}
