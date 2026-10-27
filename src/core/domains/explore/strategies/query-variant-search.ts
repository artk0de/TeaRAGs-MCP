/**
 * The search half of query variants (bd tea-rags-mcp-2vuz), shared by the
 * vector and hybrid strategies: ONE fused Qdrant request over every variant's
 * legs, filled to the pathPattern target and grouped per file like the
 * single-query paths. RRF fusion has no `queryGroups` form, so `level: "file"`
 * over-fetches chunks and groups them here, as hybrid search does.
 */

import type { QdrantSearchReader } from "../../../adapters/qdrant/ports.js";
import type { FusedSearchLeg } from "../../../adapters/qdrant/types.js";
import { FileLevelGrouper } from "../chunk-grouping/index.js";
import { fetchPathPatternMatches } from "./path-pattern-fill.js";
import type { ExploreContext, ExploreResult } from "./types.js";

export async function searchQueryVariants(
  qdrant: Pick<QdrantSearchReader, "fusedSearch">,
  ctx: ExploreContext,
  legs: readonly FusedSearchLeg[],
): Promise<ExploreResult[]> {
  const fileLevel = ctx.level === "file";
  const results = await fetchPathPatternMatches(
    ctx.pathPattern,
    {
      fetchLimit: fileLevel ? ctx.limit * 3 : ctx.limit,
      fetchUnit: "chunk",
      target: ctx.limit,
      targetUnit: fileLevel ? "file" : "chunk",
    },
    async (limit) => qdrant.fusedSearch(ctx.collectionName, legs, limit, ctx.filter),
  );
  return fileLevel ? FileLevelGrouper.group(results, ctx.limit) : results;
}
