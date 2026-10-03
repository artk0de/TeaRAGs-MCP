/**
 * SimilarSearchStrategy — find similar chunks via Qdrant recommend API.
 *
 * Unlike other strategies (cached in ExploreFacade constructor), this is
 * created per-request because it needs positive/negative inputs per call.
 *
 * On a working tree (bd tea-rags-mcp-xi2r9, live probe P1-2) an id may name a
 * row of the TREE — hybrid_search and find_symbol hand those out beside base
 * rows. Such a row is not in Qdrant, or is with the vector of the pre-edit
 * content, so its content is embedded and used as a code example instead: the
 * vector it would carry once indexed. An id is matched in its stored form
 * (`toQdrantPointId`), so a `chunk_<hex>` id from an older answer resolves too.
 * Every other id goes to Qdrant, and one Qdrant does not hold surfaces as
 * `ChunkNotFoundError`.
 *
 * Dense floor (WTO-5): a tree row's own vector stands in for its content when
 * the floor has it (no re-embedding), the touched files' base rows leave the
 * Qdrant request (one `has_id`), and the tree's rows are scored locally with
 * the recommend arithmetic Qdrant applies (`recommendWorkingTreeScore`) —
 * against the examples' vectors, a base id's read from its stored point — and
 * merged with the page by score. An example is never its own result.
 */

import { READ_PATH_EMBEDDING_RECOVERY_WAIT_MS, type EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { QdrantPointNotFoundError } from "../../../adapters/qdrant/errors.js";
import { toQdrantPointId } from "../../../adapters/qdrant/point-id.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import { compilePathPatternMatcher } from "../../../infra/path-pattern.js";
import { FileLevelGrouper } from "../chunk-grouping/index.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import { ChunkNotFoundError } from "../errors.js";
import type { Reranker } from "../reranker.js";
import { recommendWorkingTreeScore, type WorkingTreeDenseVectors } from "../working-tree/dense-floor.js";
import type { WorkingTreeView } from "../working-tree/overlay.js";
import { fuseWorkingTreeRows, workingTreeRowAdmitted } from "../working-tree/sparse-floor.js";
import { relativePathOf, workingTreeCounterpartIds } from "../working-tree/substitute.js";
import { recordWorkingTreeDenseState } from "../working-tree/tree-graph-marker.js";
import { BaseExploreStrategy } from "./base.js";
import { fetchPathPatternMatches } from "./path-pattern-fill.js";
import type { ExploreContext, ExploreResult } from "./types.js";

export interface SimilarSearchInput {
  positiveIds?: string[];
  positiveCode?: string[];
  negativeIds?: string[];
  negativeCode?: string[];
  strategy?: "best_score" | "average_vector" | "sum_scores";
  fileExtensions?: string[];
}

export class SimilarSearchStrategy extends BaseExploreStrategy {
  readonly type = "similar" as const;

  constructor(
    qdrant: QdrantManager,
    reranker: Reranker,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
    private readonly embeddings: EmbeddingProvider,
    private readonly input: SimilarSearchInput,
  ) {
    super(qdrant, reranker, payloadSignals, essentialKeys);
  }

  /** The dense floor needs the tree's rows AND their vectors; without a dense source the stale rows are flagged. */
  protected override hasWorkingTreeFloor(view: WorkingTreeView): boolean {
    return view.readDeltaChunks !== undefined && view.readDeltaVectors !== undefined;
  }

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    // 0. Ids naming rows of the working tree become examples: their own vector
    //    when the dense floor has it, else their content to embed.
    const floor = await this.readWorkingTreeDenseFloor(ctx);
    const dense = await floor?.dense;
    const treeContent = await this.readWorkingTreeContent(ctx);
    const treeVectors = dense?.vectors ?? new Map<string, readonly number[]>();
    const positiveExamples = splitWorkingTreeIds(this.input.positiveIds, treeContent, treeVectors);
    const negativeExamples = splitWorkingTreeIds(this.input.negativeIds, treeContent, treeVectors);

    // 1. Collect code blocks to embed (filter empty strings)
    const positiveCodeBlocks = [...(this.input.positiveCode ?? []), ...positiveExamples.treeCode].filter(
      (c) => c.trim().length > 0,
    );
    const negativeCodeBlocks = [...(this.input.negativeCode ?? []), ...negativeExamples.treeCode].filter(
      (c) => c.trim().length > 0,
    );
    const allCodeBlocks = [...positiveCodeBlocks, ...negativeCodeBlocks];

    // 2. Embed all code blocks in one batch — a read: a down provider fails it
    //    at once rather than after the indexing-sized recovery wait.
    let embeddedVectors: number[][] = [];
    if (allCodeBlocks.length > 0) {
      const results = await this.embeddings.embedBatch(allCodeBlocks, {
        maxRecoveryWaitMs: READ_PATH_EMBEDDING_RECOVERY_WAIT_MS,
      });
      embeddedVectors = results.map((r) => r.embedding);
    }

    // 3. Split embedded vectors back into positive/negative
    const positiveVectors = embeddedVectors.slice(0, positiveCodeBlocks.length);
    const negativeVectors = embeddedVectors.slice(positiveCodeBlocks.length);

    // 4. Build positive/negative arrays (IDs + vectors)
    const positive: (string | number[])[] = [
      ...positiveExamples.ids,
      ...positiveExamples.treeVectors.map((v) => [...v]),
      ...positiveVectors,
    ];
    const negative: (string | number[])[] = [
      ...negativeExamples.ids,
      ...negativeExamples.treeVectors.map((v) => [...v]),
      ...negativeVectors,
    ];

    // 5. Build filter (merge user filter + fileExtensions); the dense floor
    //    leaves the touched files' base rows out of it.
    const requestFilter = this.buildFilter(ctx.filter, this.input.fileExtensions);
    const filter = floor ? await this.excludeWorkingTreeBase(ctx, floor.view, requestFilter) : requestFilter;

    // 6. Call Qdrant query (overfetch for file-level dedup). An exact pathPattern
    //    narrows the page client-side, so a server offset would skip SUPERSET
    //    points the exact filter never saw — the base slices it off exact matches.
    //    Under the dense floor the page is merged with the tree's rows before
    //    the base slices `offset`, so the server must not skip it as well.
    const fetchLimit = ctx.level === "file" ? ctx.limit * 3 : ctx.limit;
    const offset = compilePathPatternMatcher(ctx.pathPattern) || floor ? undefined : ctx.offset;
    const results = await fetchPathPatternMatches(
      ctx.pathPattern,
      { fetchLimit, fetchUnit: "chunk", target: ctx.limit, targetUnit: ctx.level === "file" ? "file" : "chunk" },
      async (limit) => {
        try {
          return await this.qdrant.query(ctx.collectionName, {
            positive,
            negative: negative.length > 0 ? negative : undefined,
            strategy: this.input.strategy ?? "best_score",
            limit,
            offset,
            filter,
          });
        } catch (error) {
          if (error instanceof QdrantPointNotFoundError) {
            throw new ChunkNotFoundError(error);
          }
          throw error;
        }
      },
    );

    const merged =
      floor && dense
        ? fuseWorkingTreeRows(
            results.filter((row) => !floor.view.touchedPaths.has(relativePathOf(row.payload))),
            await this.scoreWorkingTreeRows(floor.view, floor.rows, dense, ctx, requestFilter, {
              positive: [...positiveExamples.treeVectors, ...positiveVectors],
              negative: [...negativeExamples.treeVectors, ...negativeVectors],
              positiveIds: positiveExamples.ids,
              negativeIds: negativeExamples.ids,
            }),
            ctx.level === "file" ? Number.POSITIVE_INFINITY : Math.max(fetchLimit, results.length),
          )
        : results;

    // Client-side grouping for file level
    if (ctx.level === "file") {
      return FileLevelGrouper.group(merged, ctx.limit);
    }
    return merged;
  }

  /**
   * The tree's admitted rows scored by the recommend arithmetic against every
   * example's vector — a base id's read from its stored point. An example row
   * is never its own result. Records what the floor gave this answer.
   */
  private async scoreWorkingTreeRows(
    view: WorkingTreeView,
    rows: readonly ScrollChunk[],
    dense: WorkingTreeDenseVectors,
    ctx: ExploreContext,
    requestFilter: Record<string, unknown> | undefined,
    examples: {
      positive: readonly (readonly number[])[];
      negative: readonly (readonly number[])[];
      positiveIds: readonly string[];
      negativeIds: readonly string[];
    },
  ): Promise<ExploreResult[]> {
    const baseIds = [...examples.positiveIds, ...examples.negativeIds];
    // Without the examples' vectors the tree's rows cannot be scored: the
    // answer is the base page, and the marker says why the tree is absent.
    const stored = await (
      baseIds.length > 0
        ? this.qdrant.retrieveDenseVectors(ctx.collectionName, baseIds, ["relativePath", "symbolId"])
        : Promise.resolve([])
    ).catch((error: unknown) => ({ failed: error instanceof Error ? error.message : String(error) }));
    if (!Array.isArray(stored)) {
      const reason = `cannot read the examples' stored vectors: ${stored.failed}`;
      recordWorkingTreeDenseState(view, { ...dense, pending: rows.length, failure: reason }, 0);
      return [];
    }
    const storedById = new Map(stored.map((point) => [String(point.id), point.vector]));
    const vectorsOf = (ids: readonly string[]): (readonly number[])[] =>
      ids.flatMap((id) => {
        const vector = storedById.get(String(toQdrantPointId(id))) ?? storedById.get(id);
        return vector ? [vector] : [];
      });
    const positive = [...vectorsOf(examples.positiveIds), ...examples.positive];
    const negative = [...vectorsOf(examples.negativeIds), ...examples.negative];
    // An example is never its own result: by id, and — a base id of a touched
    // file — by its tree counterpart, the current copy of that symbol (live
    // round-3 D2).
    const exampleIds = new Set([
      ...[...(this.input.positiveIds ?? []), ...(this.input.negativeIds ?? [])].flatMap((id) => [
        id,
        String(toQdrantPointId(id)),
      ]),
      ...workingTreeCounterpartIds(
        view,
        rows,
        stored.map((point) => point.payload),
      ),
    ]);
    const admission = { requestFilter, pathMatcher: compilePathPatternMatcher(ctx.pathPattern) };
    const scored: ExploreResult[] = [];
    if (positive.length > 0) {
      for (const row of rows) {
        const vector = dense.vectors.get(String(row.id));
        if (!vector || exampleIds.has(String(row.id)) || !workingTreeRowAdmitted(row, admission)) continue;
        scored.push({
          id: row.id,
          score: recommendWorkingTreeScore(vector, positive, negative, this.input.strategy ?? "best_score"),
          payload: row.payload,
        });
      }
    }
    recordWorkingTreeDenseState(view, dense, scored.length);
    return scored.sort((a, b) => b.score - a.score);
  }

  /**
   * Content of the tree's rows by stored id; empty when the request reads no
   * tree, the tree touched nothing, or no chunk layer can read its rows.
   */
  private async readWorkingTreeContent(ctx: ExploreContext): Promise<ReadonlyMap<string, string>> {
    const view = ctx.workingTreeView;
    if (!view?.readDeltaChunks || view.touchedPaths.size === 0) return new Map();
    const rows = await view.readDeltaChunks();
    return new Map(
      rows.map((row) => [String(row.id), typeof row.payload.content === "string" ? row.payload.content : ""]),
    );
  }

  private buildFilter(
    userFilter?: Record<string, unknown>,
    fileExtensions?: string[],
  ): Record<string, unknown> | undefined {
    const extensionCondition = fileExtensions?.length
      ? { key: "fileExtension", match: { any: fileExtensions } }
      : undefined;

    if (!userFilter && !extensionCondition) return undefined;

    const mustClauses: unknown[] = [];

    // Merge existing must clauses from user filter
    if (userFilter) {
      if (Array.isArray(userFilter.must)) {
        mustClauses.push(...(userFilter.must as unknown[]));
      } else if (!userFilter.must && !userFilter.should && !userFilter.must_not) {
        // Simple key-value filter — convert to must format
        const entries = Object.entries(userFilter).map(([key, value]) => ({
          key,
          match: { value },
        }));
        mustClauses.push(...entries);
      }
    }

    if (extensionCondition) {
      mustClauses.push(extensionCondition);
    }

    if (mustClauses.length === 0) return userFilter;

    // Preserve should/must_not from user filter
    const result: Record<string, unknown> = { must: mustClauses };
    if (userFilter?.should) result.should = userFilter.should;
    if (userFilter?.must_not) result.must_not = userFilter.must_not;
    return result;
  }
}

/**
 * `ids` split into the ones Qdrant answers and the tree rows that stand in for
 * the rest: by their own vector when the dense floor has one, else by their
 * content to embed. An id is matched in its stored form (`toQdrantPointId`).
 */
function splitWorkingTreeIds(
  ids: readonly string[] | undefined,
  treeContent: ReadonlyMap<string, string>,
  treeVectors: ReadonlyMap<string, readonly number[]>,
): { ids: string[]; treeCode: string[]; treeVectors: (readonly number[])[] } {
  const split: { ids: string[]; treeCode: string[]; treeVectors: (readonly number[])[] } = {
    ids: [],
    treeCode: [],
    treeVectors: [],
  };
  for (const id of ids ?? []) {
    const key = String(toQdrantPointId(id));
    const content = treeContent.get(key);
    const vector = treeVectors.get(key);
    if (content === undefined) split.ids.push(id);
    else if (vector) split.treeVectors.push(vector);
    else split.treeCode.push(content);
  }
  return split;
}
