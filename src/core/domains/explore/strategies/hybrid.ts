/**
 * HybridSearchStrategy — combined dense + sparse (BM25) vector search.
 *
 * Validates that the collection has hybrid search enabled,
 * generates sparse vector from query, and executes hybrid search.
 * Extracted from MCP search.ts hybrid_search handler.
 */

import { QdrantInvalidQueryParameterError } from "../../../adapters/qdrant/errors.js";
import { generateSparseVector } from "../../../adapters/qdrant/sparse.js";
import { compilePathPatternMatcher } from "../../../infra/path-pattern.js";
import { FileLevelGrouper } from "../chunk-grouping/index.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import { InvalidQueryError } from "../errors.js";
import { scoreWorkingTreeRowsByVector, WORKING_TREE_DENSE_WAIT_MS } from "../working-tree/dense-floor.js";
import { claimWorkingTreeFloors, relativePathOf } from "../working-tree/index.js";
import { fuseWorkingTreeRows, scoreWorkingTreeRows, workingTreeRowAdmitted } from "../working-tree/sparse-floor.js";
import { recordWorkingTreeDenseState } from "../working-tree/tree-graph-marker.js";
import { BaseExploreStrategy } from "./base.js";
import { fetchPathPatternMatches } from "./path-pattern-fill.js";
import { buildSymbolIdentityFilter, isSymbolIdentifierQuery } from "./symbol-identity-leg.js";
import { HybridNotEnabledError, type ExploreContext, type ExploreResult } from "./types.js";

/**
 * The adapter refuses an out-of-range query parameter with its own error, since
 * `adapters` may not import this domain; the MCP client has always seen that
 * refusal as explore's `InvalidQueryError`, so it is translated here, at the
 * one explore call site that reaches the check (bd tea-rags-mcp-pn12w).
 */
function rethrowAsInvalidQuery(error: unknown): never {
  if (error instanceof QdrantInvalidQueryParameterError) throw new InvalidQueryError(error.reason);
  throw error;
}

export class HybridSearchStrategy extends BaseExploreStrategy {
  readonly type = "hybrid" as const;

  /** The sparse floor substitutes the tree's rows for touched files, so they carry no `treeState`. */
  protected override readonly hasChunkFloor = true;

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    const { embedding } = ctx;
    if (!embedding) {
      throw new InvalidQueryError("HybridSearchStrategy requires an embedding in the context");
    }

    const collectionInfo = await this.qdrant.getCollectionInfo(ctx.collectionName);
    if (!collectionInfo.hybridEnabled) {
      throw new HybridNotEnabledError(ctx.collectionName);
    }

    const sparseVector = ctx.sparseVector ?? generateSparseVector(ctx.query ?? "");
    const fetchLimit = ctx.level === "file" ? ctx.limit * 3 : ctx.limit;

    // One identifier → add the identity leg (see ./symbol-identity-leg.ts);
    // any other query sends exactly the two-prefetch request it always did.
    const identityFilter = isSymbolIdentifierQuery(ctx.query) ? buildSymbolIdentityFilter(ctx.query) : undefined;
    // Sparse floor (bd tea-rags-mcp-xi2r9.4): the tree's rows of the files it
    // touched replace their base rows. Absent → today's request, byte for byte.
    const treeRows = await this.readWorkingTreeRows(ctx);
    const view = treeRows ? ctx.workingTreeView : undefined;
    // The touched files' base points come from the view's ONE read, the one
    // the delta signals already made for this request; a view without a
    // reader wired falls back to the strategy's own (same reader, same cache
    // rules).
    const filter = view ? await this.excludeWorkingTreeBase(ctx, view, ctx.filter) : ctx.filter;
    // Dense floor (WTO-5): the tree's rows rank on the dense leg by their own
    // vectors, read beside the Qdrant request.
    const denseRanking = treeRows ? this.readWorkingTreeDenseRanking(ctx, treeRows, embedding) : undefined;
    // A base row of a touched file the request still returned (an id set that
    // predates an index run of the same point count) is dropped, never shown.
    const untouched = (rows: ExploreResult[]): ExploreResult[] =>
      view ? rows.filter((row) => !view.touchedPaths.has(relativePathOf(row.payload))) : rows;
    const baseResults = await fetchPathPatternMatches(
      ctx.pathPattern,
      { fetchLimit, fetchUnit: "chunk", target: ctx.limit, targetUnit: ctx.level === "file" ? "file" : "chunk" },
      async (limit) =>
        untouched(
          await (
            identityFilter
              ? this.qdrant.hybridSearch(
                  ctx.collectionName,
                  embedding,
                  sparseVector,
                  limit,
                  filter,
                  undefined,
                  identityFilter,
                )
              : this.qdrant.hybridSearch(ctx.collectionName, embedding, sparseVector, limit, filter)
          ).catch(rethrowAsInvalidQuery),
        ),
    );
    const ranking = await denseRanking;
    const scoredTreeRows =
      view && treeRows
        ? scoreWorkingTreeRows(treeRows, {
            querySparse: sparseVector,
            requestFilter: ctx.filter,
            identityFilter,
            pathMatcher: compilePathPatternMatcher(ctx.pathPattern),
            legLimit: fetchLimit,
            ...(ranking ? { denseRanking: ranking } : {}),
          })
        : undefined;
    // The floors are the tree rows' only once one of them is a candidate (D8).
    if (view && scoredTreeRows) claimWorkingTreeFloors(view, ["chunks", "sparse"], scoredTreeRows.length);
    const results = scoredTreeRows
      ? fuseWorkingTreeRows(baseResults, scoredTreeRows, Math.max(fetchLimit, baseResults.length))
      : baseResults;

    // queryGroups has no fusion=rrf option; fetch limit*3 above and group client-side.
    if (ctx.level === "file") {
      return FileLevelGrouper.group(results, ctx.limit);
    }

    return results;
  }

  /**
   * The dense leg's order: ids of the tree's admitted rows that have a vector,
   * best cosine first. Undefined when the view has no dense source. Records
   * what the floor gave this answer.
   */
  private async readWorkingTreeDenseRanking(
    ctx: ExploreContext,
    rows: readonly ScrollChunk[],
    embedding: readonly number[],
  ): Promise<(string | number)[] | undefined> {
    const view = ctx.workingTreeView;
    if (!view?.readDeltaVectors) return undefined;
    const dense = await view.readDeltaVectors(WORKING_TREE_DENSE_WAIT_MS);
    const admission = { requestFilter: ctx.filter, pathMatcher: compilePathPatternMatcher(ctx.pathPattern) };
    const ranked = scoreWorkingTreeRowsByVector(rows, dense.vectors, embedding, (row) =>
      workingTreeRowAdmitted(row, admission),
    );
    recordWorkingTreeDenseState(view, dense, ranked.length);
    return ranked.flatMap((row) => (row.id === undefined ? [] : [row.id]));
  }

  /** The tree's rows when this request reads a tree that touched files and can chunk them. */
  private async readWorkingTreeRows(ctx: ExploreContext): Promise<readonly ScrollChunk[] | undefined> {
    const view = ctx.workingTreeView;
    if (!view?.readDeltaChunks || view.touchedPaths.size === 0) return undefined;
    return view.readDeltaChunks();
  }
}
