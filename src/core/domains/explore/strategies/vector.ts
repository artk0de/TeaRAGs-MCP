/**
 * VectorSearchStrategy — semantic vector search via Qdrant.
 *
 * Executes a dense vector search against a collection.
 * Extracted from MCP search.ts semantic_search handler.
 *
 * Dense floor (bd tea-rags-mcp-xi2r9, WTO-5): on a tree that touched files, the
 * Qdrant request leaves out their base rows (one `has_id`) and the tree's rows
 * of those files are scored locally — exact cosine of their own vectors
 * against the query vector — and merged with the page by score.
 */

import { compilePathPatternMatcher } from "../../../infra/path-pattern.js";
import { FileLevelGrouper } from "../chunk-grouping/index.js";
import { InvalidQueryError } from "../errors.js";
import { scoreWorkingTreeRowsByVector } from "../working-tree/dense-floor.js";
import type { WorkingTreeView } from "../working-tree/overlay.js";
import { fuseWorkingTreeRows, workingTreeRowAdmitted } from "../working-tree/sparse-floor.js";
import { relativePathOf } from "../working-tree/substitute.js";
import { recordWorkingTreeDenseState } from "../working-tree/tree-graph-marker.js";
import { BaseExploreStrategy, type WorkingTreeDenseFloorRead } from "./base.js";
import { fetchPathPatternMatches } from "./path-pattern-fill.js";
import type { ExploreContext, ExploreResult } from "./types.js";

/**
 * Hits collected per file. The file-level result is the top hit alone — the
 * collapsed hits are not surfaced (bd tea-rags-mcp-947xf) — so one per group.
 */
const FILE_GROUP_SIZE = 1;

export class VectorSearchStrategy extends BaseExploreStrategy {
  readonly type = "vector" as const;

  /** The dense floor needs the tree's rows AND their vectors; without a dense source the stale rows are flagged. */
  protected override hasWorkingTreeFloor(view: WorkingTreeView): boolean {
    return view.readDeltaChunks !== undefined && view.readDeltaVectors !== undefined;
  }

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    const { embedding } = ctx;
    if (!embedding) {
      throw new InvalidQueryError("VectorSearchStrategy requires an embedding in the context");
    }
    const floor = await this.readWorkingTreeDenseFloor(ctx);
    const filter = floor ? await this.excludeWorkingTreeBase(ctx, floor.view, ctx.filter) : ctx.filter;
    // A base row of a touched file the request still returned (an id set that
    // predates an index run of the same point count) is dropped, never shown.
    const untouched = (rows: ExploreResult[]): ExploreResult[] =>
      floor ? rows.filter((row) => !floor.view.touchedPaths.has(relativePathOf(row.payload))) : rows;
    if (ctx.level === "file") {
      // Groups are keyed on relativePath, so the server's limit counts FILES.
      const grouped = await fetchPathPatternMatches(
        ctx.pathPattern,
        { fetchLimit: ctx.limit, fetchUnit: "file", target: ctx.limit, targetUnit: "file" },
        async (limit) =>
          untouched(
            await this.qdrant.queryGroups(ctx.collectionName, embedding, {
              groupBy: "relativePath",
              groupSize: FILE_GROUP_SIZE,
              limit,
              filter,
            }),
          ),
      );
      const merged = floor
        ? fuseWorkingTreeRows(grouped, await this.scoreWorkingTreeRows(floor, ctx, embedding), Number.POSITIVE_INFINITY)
        : grouped;
      return FileLevelGrouper.group(merged, ctx.limit);
    }
    const base = await fetchPathPatternMatches(
      ctx.pathPattern,
      { fetchLimit: ctx.limit, fetchUnit: "chunk", target: ctx.limit, targetUnit: "chunk" },
      async (limit) => untouched(await this.qdrant.search(ctx.collectionName, embedding, limit, filter)),
    );
    if (!floor) return base;
    const tree = await this.scoreWorkingTreeRows(floor, ctx, embedding);
    return fuseWorkingTreeRows(base, tree, Math.max(ctx.limit, base.length));
  }

  /** The tree's admitted rows scored by their own vectors; records what the floor gave this answer. */
  private async scoreWorkingTreeRows(
    floor: WorkingTreeDenseFloorRead,
    ctx: ExploreContext,
    embedding: readonly number[],
  ): Promise<ExploreResult[]> {
    const dense = await floor.dense;
    const admission = { requestFilter: ctx.filter, pathMatcher: compilePathPatternMatcher(ctx.pathPattern) };
    const scored = scoreWorkingTreeRowsByVector(floor.rows, dense.vectors, embedding, (row) =>
      workingTreeRowAdmitted(row, admission),
    );
    recordWorkingTreeDenseState(floor.view, dense, scored.length);
    return scored;
  }
}
