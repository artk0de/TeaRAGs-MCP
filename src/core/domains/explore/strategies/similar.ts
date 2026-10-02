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
 */

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { QdrantPointNotFoundError } from "../../../adapters/qdrant/errors.js";
import { toQdrantPointId } from "../../../adapters/qdrant/point-id.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import { compilePathPatternMatcher } from "../../../infra/path-pattern.js";
import { FileLevelGrouper } from "../chunk-grouping/index.js";
import { ChunkNotFoundError } from "../errors.js";
import type { Reranker } from "../reranker.js";
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

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    // 0. Ids naming rows of the working tree become code examples (their content).
    const treeContent = await this.readWorkingTreeContent(ctx);
    const positiveExamples = splitWorkingTreeIds(this.input.positiveIds, treeContent);
    const negativeExamples = splitWorkingTreeIds(this.input.negativeIds, treeContent);

    // 1. Collect code blocks to embed (filter empty strings)
    const positiveCodeBlocks = [...(this.input.positiveCode ?? []), ...positiveExamples.treeCode].filter(
      (c) => c.trim().length > 0,
    );
    const negativeCodeBlocks = [...(this.input.negativeCode ?? []), ...negativeExamples.treeCode].filter(
      (c) => c.trim().length > 0,
    );
    const allCodeBlocks = [...positiveCodeBlocks, ...negativeCodeBlocks];

    // 2. Embed all code blocks in one batch
    let embeddedVectors: number[][] = [];
    if (allCodeBlocks.length > 0) {
      const results = await this.embeddings.embedBatch(allCodeBlocks);
      embeddedVectors = results.map((r) => r.embedding);
    }

    // 3. Split embedded vectors back into positive/negative
    const positiveVectors = embeddedVectors.slice(0, positiveCodeBlocks.length);
    const negativeVectors = embeddedVectors.slice(positiveCodeBlocks.length);

    // 4. Build positive/negative arrays (IDs + vectors)
    const positive: (string | number[])[] = [...positiveExamples.ids, ...positiveVectors];
    const negative: (string | number[])[] = [...negativeExamples.ids, ...negativeVectors];

    // 5. Build filter (merge user filter + fileExtensions)
    const filter = this.buildFilter(ctx.filter, this.input.fileExtensions);

    // 6. Call Qdrant query (overfetch for file-level dedup). An exact pathPattern
    //    narrows the page client-side, so a server offset would skip SUPERSET
    //    points the exact filter never saw — the base slices it off exact matches.
    const fetchLimit = ctx.level === "file" ? ctx.limit * 3 : ctx.limit;
    const offset = compilePathPatternMatcher(ctx.pathPattern) ? undefined : ctx.offset;
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

    // Client-side grouping for file level
    if (ctx.level === "file") {
      return FileLevelGrouper.group(results, ctx.limit);
    }
    return results;
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

/** `ids` split into the ones Qdrant answers and the tree rows' content that stands in for the rest. */
function splitWorkingTreeIds(
  ids: readonly string[] | undefined,
  treeContent: ReadonlyMap<string, string>,
): { ids: string[]; treeCode: string[] } {
  const split: { ids: string[]; treeCode: string[] } = { ids: [], treeCode: [] };
  for (const id of ids ?? []) {
    const content = treeContent.get(String(toQdrantPointId(id)));
    if (content === undefined) split.ids.push(id);
    else split.treeCode.push(content);
  }
  return split;
}
