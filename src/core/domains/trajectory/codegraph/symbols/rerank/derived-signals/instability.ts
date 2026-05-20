import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";

export class InstabilitySignal implements DerivedSignalDescriptor {
  readonly name = "instability";
  readonly description = "Martin instability ratio (already normalised to [0,1])";
  readonly sources = ["codegraph.file.instability"];
  readonly defaultBound = 1;
  extract(raw: Record<string, unknown>, _ctx?: ExtractContext): number {
    const v = Number(raw["codegraph.file.instability"] ?? 0);
    if (Number.isNaN(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }
}
