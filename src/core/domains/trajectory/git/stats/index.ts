/**
 * Git-trajectory collection-stats accumulators.
 *
 * Each accumulator reads only payload fields owned by git enrichment
 * (`git.file.*`, `git.chunk.*`) — ingest layer never references these
 * keys directly.
 */

import type { StatsAccumulatorDescriptor } from "../../../../contracts/types/stats-accumulator.js";
import { blameAuthorCountsDescriptor, recentAuthorCountsDescriptor } from "./author-counts.js";
import { chunkTimeRangeDescriptor } from "./chunk-time-range.js";
import { fileTimeRangeDescriptor } from "./file-time-range.js";
import { gitDataPathsDescriptor } from "./git-data-paths.js";

export { BlameAuthorCountsAccumulator, RecentAuthorCountsAccumulator } from "./author-counts.js";
export { ChunkTimeRangeAccumulator, type ChunkTimeRangeResult } from "./chunk-time-range.js";
export { FileTimeRangeAccumulator, type FileTimeRangeResult } from "./file-time-range.js";
export { GitDataPathsAccumulator } from "./git-data-paths.js";

export const gitStatsAccumulators: readonly StatsAccumulatorDescriptor[] = [
  recentAuthorCountsDescriptor,
  blameAuthorCountsDescriptor,
  fileTimeRangeDescriptor,
  chunkTimeRangeDescriptor,
  gitDataPathsDescriptor,
];
