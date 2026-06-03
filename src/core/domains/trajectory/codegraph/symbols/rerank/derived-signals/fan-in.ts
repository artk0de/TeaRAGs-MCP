import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../../contracts/signal-utils.js";
import { codegraphFileNum } from "./helpers.js";

export class FanInSignal implements DerivedSignalDescriptor {
  readonly name = "fanIn";
  readonly description = "Normalized number of files importing this file";
  readonly sources = ["codegraph.file.fanIn"];
  readonly defaultBound = 20;
  extract(raw: Record<string, unknown>, ctx?: ExtractContext): number {
    const v = codegraphFileNum(raw, "fanIn");
    const bound = ctx?.bounds?.["file.fanIn"] ?? this.defaultBound;
    return normalize(v, bound);
  }
}
