/**
 * Static-trajectory collection-stats accumulators.
 *
 * Structural counts/sets derived from payload fields that exist regardless
 * of git enrichment (language, chunkType, isDocumentation, relativePath).
 */

import type { StatsAccumulatorDescriptor } from "../../../../contracts/types/stats-accumulator.js";
import { chunkTypeCountsDescriptor } from "./chunk-type-counts.js";
import { distinctPathsDescriptor } from "./distinct-paths.js";
import { docsCodeCountsDescriptor } from "./docs-code-counts.js";
import { languageCountsDescriptor } from "./language-counts.js";

export { ChunkTypeCountsAccumulator } from "./chunk-type-counts.js";
export { DistinctPathsAccumulator } from "./distinct-paths.js";
export { DocsCodeCountsAccumulator, type DocsCodeCountsResult } from "./docs-code-counts.js";
export { LanguageCountsAccumulator } from "./language-counts.js";

export const staticStatsAccumulators: readonly StatsAccumulatorDescriptor[] = [
  languageCountsDescriptor,
  chunkTypeCountsDescriptor,
  docsCodeCountsDescriptor,
  distinctPathsDescriptor,
];
