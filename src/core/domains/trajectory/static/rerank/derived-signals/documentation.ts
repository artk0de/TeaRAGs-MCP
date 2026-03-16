import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";

/**
 * Binary signal: is this chunk from a documentation file?
 *
 * Purpose: boost or filter documentation in search results.
 * Detects: README, docs, comments, guides — chunks with isDocumentation=true.
 * Scoring: 1.0 if documentation, 0.0 otherwise. No gradation.
 * Used in: onboarding preset (boost docs for newcomers).
 *   Also useful with documentation typed filter ("only" / "exclude" / "include").
 */
export class DocumentationSignal implements DerivedSignalDescriptor {
  readonly name = "documentation";
  readonly description = "Documentation file boost (1 if isDocumentation, 0 otherwise)";
  readonly sources: string[] = [];
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    return rawSignals.isDocumentation ? 1 : 0;
  }
}
