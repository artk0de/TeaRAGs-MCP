/**
 * Git Metadata Module
 *
 * Provides git-aware metadata enrichment for semantic chunks:
 * - File-level git metadata via isomorphic-git (0 process spawns)
 * - Research-backed churn metrics (Nagappan & Ball 2005)
 * - Background enrichment (non-blocking)
 */

export { GitMetadataService } from "./git-metadata-service.js";
export { GitLogReader, computeFileMetadata, extractTaskIds } from "./git-log-reader.js";
export type {
  BlameCache,
  BlameCacheFile,
  BlameLineData,
  CommitInfo,
  FileChurnData,
  GitChunkMetadata,
  GitFileMetadata,
  GitMetadataOptions,
  GitRepoInfo,
} from "./types.js";
