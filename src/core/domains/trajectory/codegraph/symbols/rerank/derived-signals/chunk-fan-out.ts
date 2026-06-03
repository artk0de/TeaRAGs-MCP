import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../../contracts/signal-utils.js";
import { codegraphChunkNum } from "./helpers.js";

/**
 * Method-level (chunk-scope) fan-out: how many outgoing calls this
 * symbol makes. Counterpart of `ChunkFanInSignal`; the file-scope
 * `FanOutSignal` measures import-edge fan-out on a separate graph.
 */
export class ChunkFanOutSignal implements DerivedSignalDescriptor {
  readonly name = "chunkFanOut";
  readonly description = "Normalized number of outgoing calls from this symbol (method-level fan-out)";
  readonly sources = ["codegraph.chunk.fanOut"];
  readonly defaultBound = 30;
  extract(raw: Record<string, unknown>, ctx?: ExtractContext): number {
    const v = codegraphChunkNum(raw, "fanOut");
    const bound = ctx?.bounds?.["chunk.fanOut"] ?? this.defaultBound;
    return normalize(v, bound);
  }
}
