import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../../infra/signal-utils.js";

export class CalledByCountSignal implements DerivedSignalDescriptor {
  readonly name = "calledByCount";
  readonly description = "Normalized number of distinct call sites invoking this symbol";
  readonly sources = ["codegraph.chunk.calledByCount"];
  readonly defaultBound = 40;
  extract(raw: Record<string, unknown>, ctx?: ExtractContext): number {
    const v = Number(raw["codegraph.chunk.calledByCount"] ?? 0);
    const bound = ctx?.bounds?.["chunk.calledByCount"] ?? this.defaultBound;
    return normalize(v, bound);
  }
}
