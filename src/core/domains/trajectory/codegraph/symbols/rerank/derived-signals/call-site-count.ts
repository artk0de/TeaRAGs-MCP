import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../../infra/signal-utils.js";

export class CallSiteCountSignal implements DerivedSignalDescriptor {
  readonly name = "callSiteCount";
  readonly description = "Normalized number of outgoing calls from this symbol";
  readonly sources = ["codegraph.chunk.callSiteCount"];
  readonly defaultBound = 30;
  extract(raw: Record<string, unknown>, ctx?: ExtractContext): number {
    const v = Number(raw["codegraph.chunk.callSiteCount"] ?? 0);
    const bound = ctx?.bounds?.["chunk.callSiteCount"] ?? this.defaultBound;
    return normalize(v, bound);
  }
}
