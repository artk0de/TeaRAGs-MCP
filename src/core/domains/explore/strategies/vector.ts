/**
 * VectorSearchStrategy — semantic vector search via Qdrant.
 *
 * Executes a dense vector search against a collection.
 * Extracted from MCP search.ts semantic_search handler.
 */

import { FileLevelGrouper } from "../chunk-grouping/index.js";
import { InvalidQueryError } from "../errors.js";
import { BaseExploreStrategy } from "./base.js";
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
    if (!ctx.embedding) {
      throw new InvalidQueryError("VectorSearchStrategy requires an embedding in the context");
    }
    if (ctx.level === "file") {
      const grouped = await this.qdrant.queryGroups(ctx.collectionName, ctx.embedding, {
        groupBy: "relativePath",
        groupSize: FILE_GROUP_SIZE,
        limit: ctx.limit,
        filter: ctx.filter,
      });
      return FileLevelGrouper.group(grouped, ctx.limit);
    }
    return this.qdrant.search(ctx.collectionName, ctx.embedding, ctx.limit, ctx.filter);
  }
}
