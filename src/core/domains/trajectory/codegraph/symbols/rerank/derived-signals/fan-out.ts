import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../../contracts/signal-utils.js";
import { codegraphFileNum } from "./helpers.js";

export class FanOutSignal implements DerivedSignalDescriptor {
  readonly name = "fanOut";
  readonly description = "Normalized number of files this file imports";
  readonly sources = ["codegraph.file.fanOut"];
  readonly defaultBound = 20;
  extract(raw: Record<string, unknown>, ctx?: ExtractContext): number {
    const v = codegraphFileNum(raw, "fanOut");
    const bound = ctx?.bounds?.["file.fanOut"] ?? this.defaultBound;
    return normalize(v, bound);
  }
}
