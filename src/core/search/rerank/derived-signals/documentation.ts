import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";

export class DocumentationSignal implements DerivedSignalDescriptor {
  readonly name = "documentation";
  readonly description = "Documentation file boost (1 if isDocumentation, 0 otherwise)";
  readonly sources: string[] = [];
  extract(payload: Record<string, unknown>): number {
    return payload.isDocumentation ? 1 : 0;
  }
}
