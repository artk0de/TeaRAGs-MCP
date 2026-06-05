/**
 * What kind of file this is — the single FACT consumed by per-provider
 * enrichment policy (EnrichmentProvider.shouldEnrich). Canonical home.
 *
 * Domain-boundary note: core/infra/ may NOT import core/contracts/ (foundation
 * imports nothing — applies to `import type` too). So
 * infra/file-classification/classify() declares a structurally-identical local
 * return type instead of importing this one; the two are kept in sync by
 * structural assignability, mirroring the ChunkSignalOptions.blobReader ↔
 * CatFileBatchReader pairing in provider.ts.
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
