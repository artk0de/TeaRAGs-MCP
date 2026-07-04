import { normalize } from "../../../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";
import { codegraphChunkNum } from "./helpers.js";

/**
 * Method-level (chunk-scope) fan-out: how many outgoing calls this
 * symbol makes. Counterpart of `ChunkFanInSignal`; the file-scope
 * `FanOutSignal` measures import-edge fan-out on a separate graph.
 * The underlying `chunk.fanOut` payload value is a confidence-weighted
 * sum (bd tea-rags-mcp-s5ato — a whole m-way dynamic fan-out counts as
 * one call) and may be fractional — normalization is unaffected.
 */
export class ChunkFanOutSignal implements DerivedSignalDescriptor {
  readonly name = "chunkFanOut";
  readonly description = "Normalized confidence-weighted sum of outgoing calls from this symbol (method-level fan-out)";
  readonly sources = ["chunk.fanOut"];
  readonly defaultBound = 30;
  extract(raw: Record<string, unknown>, ctx?: ExtractContext): number {
    const v = codegraphChunkNum(raw, "fanOut");
    const bound = ctx?.bounds?.["chunk.fanOut"] ?? this.defaultBound;
    return normalize(v, bound);
  }
}
