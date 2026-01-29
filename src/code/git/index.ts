/**
 * Git Metadata Module - Canonical algorithm implementation
 *
 * Provides git-aware metadata enrichment for semantic chunks:
 * - One git blame per file (cached by content hash)
 * - Aggregated signals only (no per-line storage)
 * - No commit message parsing
 */

export { GitMetadataService } from "./git-metadata-service.js";
export type {
  BlameCache,
  BlameCacheFile,
  BlameLineData,
  GitChunkMetadata,
  GitMetadataOptions,
  GitRepoInfo,
} from "./types.js";
