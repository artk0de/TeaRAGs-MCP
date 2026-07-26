/**
 * What kind of file this is — the single FACT consumed by per-provider
 * enrichment policy (EnrichmentProvider.shouldEnrich). Canonical home.
 *
 * Sole declaration: `infra/file-classification/classify()` imports this type
 * and re-exports it. The foundation order (contracts < infra < adapters) makes
 * that type-only edge legal — before it was legalized, infra kept a
 * structurally-identical copy that had to be hand-synced.
 */
export interface FileClassification {
  /** Ordinary, human-edited source code. */
  isSource: boolean;
  /** Machine-generated (db/schema.rb, *.pb.go, @generated marker, vendored). */
  isGenerated: boolean;
  /** Documentation (markdown etc.) — derived from the file's language. */
  isDocumentation: boolean;
  /** Test file (*_spec.rb, *.test.ts, test dirs). */
  isTest: boolean;
}
