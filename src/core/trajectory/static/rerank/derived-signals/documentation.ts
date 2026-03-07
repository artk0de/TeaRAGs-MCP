import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";

export class DocumentationSignal implements DerivedSignalDescriptor {
  readonly name = "documentation";
  readonly description = "Documentation file boost (1 if isDocumentation, 0 otherwise)";
  readonly sources: string[] = [];
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    return rawSignals.isDocumentation ? 1 : 0;
  }
}
