import type { ChunkLookupEntry } from "../../../types.js";

/**
 * EnrichmentProvider — interface for trajectory enrichment providers.
 *
 * Each provider computes metadata at two levels:
 * - file-level: prefetched at T=0, applied as chunks arrive
 * - chunk-level: computed post-flush, applied as overlays
 *
 * Payload is written to Qdrant as { [key].file.{metric} } and { [key].chunk.{metric} }.
 */
export interface EnrichmentProvider {
  /** Namespace key for Qdrant payload: { [key].file: ..., [key].chunk: ... } */
  readonly key: string; // "git", "codegraph", "complexity"

  /** File-level enrichment (prefetch at T=0, or backfill for specific paths) */
  buildFileMetadata: (root: string, options?: { paths?: string[] }) => Promise<Map<string, Record<string, unknown>>>;

  /** Chunk-level enrichment (post-flush) */
  buildChunkMetadata: (
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ) => Promise<Map<string, Map<string, Record<string, unknown>>>>;
}
