import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { CompositeRerankPreset, OverlayMask } from "../../../../contracts/types/reranker.js";

/**
 * `entryPoint` — surfaces files that LOOK like composition roots:
 *
 *   - high outgoing imports per line (`fanOutPerLine`) — wires many
 *     things together
 *   - low fanIn — nobody imports back into them; they sit at the top
 *     of the dependency tree (main, controllers, register-all hooks)
 *   - moderate size — composition glue is usually short, not a giant
 *     monolith
 *
 * Negative weight on fanIn flips the usual blast-radius signal: a
 * file with fanIn = 0 (no consumers) is exactly what an entry point
 * is. Combined with high fanOutPerLine this surfaces the few real
 * roots in a codebase, not every util.
 *
 * Use cases: "where does this app start", "find the wiring code",
 * onboarding new contributors. Empirically aligns with files
 * containing `createApp`, `main`, `bootstrap`, register-* patterns.
 */
export class EntryPointPreset implements CompositeRerankPreset {
  readonly name = "entryPoint";
  readonly description = "Composition roots — high outgoing imports per line, no incoming";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar", "trace_path"];
  readonly requires = ["codegraph.symbols"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.3,
    fanOutPerLine: 0.3,
    fanIn: -0.2,
    chunkSize: 0.1,
  };
  readonly overlayMask: OverlayMask = {
    file: ["codegraph.file.fanIn", "codegraph.file.fanOut", "imports"],
    chunk: ["codegraph.chunk.fanIn", "codegraph.chunk.fanOut"],
  };
}
