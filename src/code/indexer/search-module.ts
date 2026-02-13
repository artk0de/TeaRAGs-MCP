/**
 * SearchModule - Semantic code search over indexed collections.
 *
 * Extracted from CodeIndexer to isolate search logic.
 */

import type { EmbeddingProvider } from "../../embeddings/base.js";
import { BM25SparseVectorGenerator } from "../../embeddings/sparse.js";
import type { QdrantManager } from "../../qdrant/client.js";
import { calculateFetchLimit, filterResultsByGlob } from "../../qdrant/filters/index.js";
import { rerankSearchCodeResults, type RerankMode, type SearchCodeRerankPreset } from "../reranker.js";
import type { CodeConfig, CodeSearchResult, SearchOptions } from "../types.js";
import { resolveCollectionName, validatePath } from "./shared.js";

export class SearchModule {
  constructor(
    private qdrant: QdrantManager,
    private embeddings: EmbeddingProvider,
    private config: CodeConfig,
  ) {}

  /**
   * Search code semantically
   */
  async searchCode(path: string, query: string, options?: SearchOptions): Promise<CodeSearchResult[]> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);

    // Check if collection exists
    const exists = await this.qdrant.collectionExists(collectionName);
    if (!exists) {
      throw new Error(`Codebase not indexed: ${path}`);
    }

    // Check if collection has hybrid search enabled
    const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);
    const useHybrid = (options?.useHybrid ?? this.config.enableHybridSearch) && collectionInfo.hybridEnabled;

    // Generate query embedding
    const { embedding } = await this.embeddings.embed(query);

    // Build filter
    let filter: any;
    // Note: pathPattern is handled via client-side filtering, not Qdrant filter
    const hasBasicFilters = options?.fileTypes || options?.documentationOnly;
    // Git filters per canonical algorithm (aggregated signals only)
    const hasGitFilters =
      options?.author ||
      options?.modifiedAfter ||
      options?.modifiedBefore ||
      options?.minAgeDays !== undefined ||
      options?.maxAgeDays !== undefined ||
      options?.minCommitCount !== undefined ||
      options?.taskId;

    if (hasBasicFilters || hasGitFilters) {
      filter = { must: [] };

      // Basic filters
      if (options?.fileTypes && options.fileTypes.length > 0) {
        filter.must.push({
          key: "fileExtension",
          match: { any: options.fileTypes },
        });
      }

      // Filter to documentation only (markdown, READMEs, etc.)
      if (options?.documentationOnly) {
        filter.must.push({
          key: "isDocumentation",
          match: { value: true },
        });
      }

      // Git metadata filters (canonical algorithm: nested git.* keys)
      if (options?.author) {
        filter.must.push({
          key: "git.dominantAuthor",
          match: { value: options.author },
        });
      }

      if (options?.modifiedAfter) {
        const timestamp = Math.floor(new Date(options.modifiedAfter).getTime() / 1000);
        filter.must.push({
          key: "git.lastModifiedAt",
          range: { gte: timestamp },
        });
      }

      if (options?.modifiedBefore) {
        const timestamp = Math.floor(new Date(options.modifiedBefore).getTime() / 1000);
        filter.must.push({
          key: "git.lastModifiedAt",
          range: { lte: timestamp },
        });
      }

      if (options?.minAgeDays !== undefined) {
        filter.must.push({
          key: "git.ageDays",
          range: { gte: options.minAgeDays },
        });
      }

      if (options?.maxAgeDays !== undefined) {
        filter.must.push({
          key: "git.ageDays",
          range: { lte: options.maxAgeDays },
        });
      }

      if (options?.minCommitCount !== undefined) {
        filter.must.push({
          key: "git.commitCount",
          range: { gte: options.minCommitCount },
        });
      }

      if (options?.taskId) {
        filter.must.push({
          key: "git.taskIds",
          match: { any: [options.taskId] },
        });
      }
    }

    // Calculate fetch limit (fetch more if we need to filter by glob pattern or rerank)
    const requestedLimit = options?.limit || this.config.defaultSearchLimit;
    const needsOverfetch = Boolean(options?.pathPattern) || Boolean(options?.rerank && options.rerank !== "relevance");
    const fetchLimit = calculateFetchLimit(requestedLimit, needsOverfetch);

    // Search with hybrid or standard search
    let results;
    if (useHybrid) {
      const sparseGenerator = new BM25SparseVectorGenerator();
      const sparseVector = sparseGenerator.generate(query);
      results = await this.qdrant.hybridSearch(collectionName, embedding, sparseVector, fetchLimit, filter);
    } else {
      results = await this.qdrant.search(collectionName, embedding, fetchLimit, filter);
    }

    // Apply glob pattern filter if specified (client-side filtering)
    let filteredResults = options?.pathPattern ? filterResultsByGlob(results, options.pathPattern) : results;

    // Apply reranking if specified
    if (options?.rerank && options.rerank !== "relevance") {
      filteredResults = rerankSearchCodeResults(filteredResults, options.rerank as RerankMode<SearchCodeRerankPreset>);
    }

    // Apply score threshold if specified
    filteredResults = options?.scoreThreshold
      ? filteredResults.filter((r) => r.score >= (options.scoreThreshold || 0))
      : filteredResults;

    // Format results (include git metadata if present)
    // Limit to requested count after all filtering
    return filteredResults.slice(0, requestedLimit).map((r) => ({
      content: r.payload?.content || "",
      filePath: r.payload?.relativePath || "",
      startLine: r.payload?.startLine || 0,
      endLine: r.payload?.endLine || 0,
      language: r.payload?.language || "unknown",
      score: r.score,
      fileExtension: r.payload?.fileExtension || "",
      // Include git metadata if it exists (file-level churn metrics)
      ...(r.payload?.git && {
        metadata: {
          git: r.payload.git,
        },
      }),
    }));
  }
}
