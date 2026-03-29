/**
 * SimilarSearchStrategy — find similar chunks via Qdrant recommend API.
 *
 * Unlike other strategies (cached in ExploreFacade constructor), this is
 * created per-request because it needs positive/negative inputs per call.
 */

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { QdrantPointNotFoundError } from "../../../adapters/qdrant/errors.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import { ChunkNotFoundError } from "../errors.js";
import type { Reranker } from "../reranker.js";
import { BaseExploreStrategy } from "./base.js";
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
    // 1. Collect code blocks to embed (filter empty strings)
    const positiveCodeBlocks = (this.input.positiveCode ?? []).filter((c) => c.trim().length > 0);
    const negativeCodeBlocks = (this.input.negativeCode ?? []).filter((c) => c.trim().length > 0);
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
    const positive: (string | number[])[] = [...(this.input.positiveIds ?? []), ...positiveVectors];
    const negative: (string | number[])[] = [...(this.input.negativeIds ?? []), ...negativeVectors];

    // 5. Build filter (merge user filter + fileExtensions)
    const filter = this.buildFilter(ctx.filter, this.input.fileExtensions);

    // 6. Call Qdrant query (overfetch for file-level dedup)
    const fetchLimit = ctx.level === "file" ? ctx.limit * 3 : ctx.limit;
    let results;
    try {
      results = await this.qdrant.query(ctx.collectionName, {
        positive,
        negative: negative.length > 0 ? negative : undefined,
        strategy: this.input.strategy ?? "best_score",
        limit: fetchLimit,
        offset: ctx.offset,
        filter,
      });
    } catch (error) {
      if (error instanceof QdrantPointNotFoundError) {
        throw new ChunkNotFoundError(error);
      }
      throw error;
    }

    // Client-side grouping for file level
    if (ctx.level === "file") {
      return this.groupByFile(results, ctx.limit);
    }
    return results;
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
