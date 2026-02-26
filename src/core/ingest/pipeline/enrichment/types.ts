import type { ChunkLookupEntry } from "../../../types.js";
import type { FileSignalTransform } from "./applier.js";

/**
 * EnrichmentProvider — interface for trajectory enrichment providers.
 *
 * Each provider computes signals at two levels:
 * - file-level: prefetched at T=0, applied as chunks arrive
 * - chunk-level: computed post-flush, applied as overlays
 *
 * Payload is written to Qdrant as { [key].file.{metric} } and { [key].chunk.{metric} }.
 */
export interface EnrichmentProvider {
  /** Namespace key for Qdrant payload: { [key].file: ..., [key].chunk: ... } */
  readonly key: string; // "git", "codegraph", "complexity"

  /** Resolve the effective root for this provider (e.g. git repo root). */
  resolveRoot: (absolutePath: string) => string;

  /**
   * Optional per-file transform applied at write time.
   * Called with (rawData, maxEndLine) when applying file-level signals.
   * Git uses this for computeFileSignals(churnData, maxEndLine).
   */
  readonly fileSignalTransform?: FileSignalTransform;

  /** File-level signal enrichment (prefetch at T=0, or backfill for specific paths) */
  buildFileSignals: (root: string, options?: { paths?: string[] }) => Promise<Map<string, Record<string, unknown>>>;

  /** Chunk-level signal enrichment (post-flush) */
  buildChunkSignals: (
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ) => Promise<Map<string, Map<string, Record<string, unknown>>>>;
}
