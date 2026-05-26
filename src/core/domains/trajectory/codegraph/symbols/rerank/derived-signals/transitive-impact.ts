import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../../infra/signal-utils.js";
import { codegraphFileNum } from "./helpers.js";

/**
 * File-level transitive blast radius. `codegraph.file.transitiveImpact`
 * is the count of distinct files reachable via reverse BFS over import
 * edges from this file (depth-capped at index time). Picks up multi-hop
 * dependencies that direct `fanIn` can't see — a utility imported by 3
 * files that are each imported by 20 has transitiveImpact ≈ 60+.
 *
 * Normalisation: `log(value+1) / log(bound+1)` would model the
 * power-law shape but the project's `normalize` helper uses linear
 * scaling and existing fanIn/fanOut signals do the same — keep consistent.
 * Use `bounds["file.transitiveImpact"]` from collection p95 stats when
 * available; fall back to defaultBound (50) on cold start.
 */
export class TransitiveImpactSignal implements DerivedSignalDescriptor {
  readonly name = "transitiveImpact";
  readonly description = "Normalized count of distinct files transitively importing this file";
  readonly sources = ["codegraph.file.transitiveImpact"];
  readonly defaultBound = 50;
  extract(raw: Record<string, unknown>, ctx?: ExtractContext): number {
    const v = codegraphFileNum(raw, "transitiveImpact");
    const bound = ctx?.bounds?.["file.transitiveImpact"] ?? this.defaultBound;
    return normalize(v, bound);
  }
}
