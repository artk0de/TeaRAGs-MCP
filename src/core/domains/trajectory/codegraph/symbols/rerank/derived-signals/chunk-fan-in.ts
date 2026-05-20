import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../../infra/signal-utils.js";

/**
 * Method-level (chunk-scope) fan-in: how many call sites invoke this
 * symbol. The file-scope `FanInSignal` measures import-edge fan-in;
 * this one measures call-graph fan-in. `chunk` prefix matches project
 * convention (cf. `chunkSize`, `chunkDensity`).
 */
export class ChunkFanInSignal implements DerivedSignalDescriptor {
  readonly name = "chunkFanIn";
  readonly description = "Normalized number of distinct call sites invoking this symbol (method-level fan-in)";
  readonly sources = ["codegraph.chunk.fanIn"];
  readonly defaultBound = 40;
  extract(raw: Record<string, unknown>, ctx?: ExtractContext): number {
    const v = Number(raw["codegraph.chunk.fanIn"] ?? 0);
    const bound = ctx?.bounds?.["chunk.fanIn"] ?? this.defaultBound;
    return normalize(v, bound);
  }
}
