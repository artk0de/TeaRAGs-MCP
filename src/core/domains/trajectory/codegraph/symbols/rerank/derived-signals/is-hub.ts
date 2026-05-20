import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";

export class IsHubSignal implements DerivedSignalDescriptor {
  readonly name = "isHub";
  readonly description = "1 when file is a hub (fanIn > collection p95)";
  readonly sources = ["codegraph.file.isHub"];
  readonly defaultBound = 1;
  extract(raw: Record<string, unknown>, _ctx?: ExtractContext): number {
    return raw["codegraph.file.isHub"] === true ? 1 : 0;
  }
}
