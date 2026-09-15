/**
 * VectorSearchStrategy — semantic vector search via Qdrant.
 *
 * Executes a dense vector search against a collection.
 * Extracted from MCP search.ts semantic_search handler.
 */

import { FileLevelGrouper } from "../chunk-grouping/index.js";
import { InvalidQueryError } from "../errors.js";
import { BaseExploreStrategy } from "./base.js";
import { fetchPathPatternMatches } from "./path-pattern-fill.js";
import type { ExploreContext, ExploreResult } from "./types.js";

/**
 * Hits collected per file so the file-level result can carry an outline of what
 * matched. One hit per group leaves nothing to aggregate; three matches the
 * file-level overfetch HybridSearchStrategy already pays.
 */
const FILE_GROUP_SIZE = 3;

export class VectorSearchStrategy extends BaseExploreStrategy {
  readonly type = "vector" as const;

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    const { embedding } = ctx;
    if (!embedding) {
      throw new InvalidQueryError("VectorSearchStrategy requires an embedding in the context");
    }
    if (ctx.level === "file") {
      // Groups are keyed on relativePath, so the server's limit counts FILES.
      const grouped = await fetchPathPatternMatches(
        ctx.pathPattern,
        { fetchLimit: ctx.limit, fetchUnit: "file", target: ctx.limit, targetUnit: "file" },
        async (limit) =>
          this.qdrant.queryGroups(ctx.collectionName, embedding, {
            groupBy: "relativePath",
            groupSize: FILE_GROUP_SIZE,
            limit,
            filter: ctx.filter,
          }),
      );
      return FileLevelGrouper.group(grouped, ctx.limit);
    }
    return fetchPathPatternMatches(
      ctx.pathPattern,
      { fetchLimit: ctx.limit, fetchUnit: "chunk", target: ctx.limit, targetUnit: "chunk" },
      async (limit) => this.qdrant.search(ctx.collectionName, embedding, limit, ctx.filter),
    );
  }
}
