import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";

export class IsLeafSignal implements DerivedSignalDescriptor {
  readonly name = "isLeaf";
  readonly description = "1 when file is a leaf (fanOut == 0 and fanIn > 0)";
  readonly sources = ["codegraph.file.isLeaf"];
  readonly defaultBound = 1;
  extract(raw: Record<string, unknown>, _ctx?: ExtractContext): number {
    return raw["codegraph.file.isLeaf"] === true ? 1 : 0;
  }
}
