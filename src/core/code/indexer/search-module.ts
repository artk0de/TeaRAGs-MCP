/**
 * SearchModule - Semantic code search over indexed collections.
 *
 * Extracted from CodeIndexer to isolate search logic.
 */

import type { EmbeddingProvider } from "../../embeddings/base.js";
import { BM25SparseVectorGenerator } from "../../embeddings/sparse.js";
import type { QdrantManager, SearchResult } from "../../qdrant/client.js";
import { calculateFetchLimit, filterResultsByGlob } from "../../qdrant/filters/index.js";
import { rerankSearchCodeResults, type RerankMode, type SearchCodeRerankPreset } from "../reranker.js";
import type { CodeConfig, CodeSearchResult, SearchOptions } from "../types.js";
import { resolveCollectionName, validatePath } from "./shared.js";

// Qdrant filter type definitions
interface QdrantMatchFilter {
  key: string;
  match: { value: unknown } | { any: unknown[] };
}

interface QdrantRangeFilter {
  key: string;
  range: { gte?: number; lte?: number };
}

type QdrantFilterCondition = QdrantMatchFilter | QdrantRangeFilter;

interface QdrantFilter {
  must?: QdrantFilterCondition[];
  should?: QdrantFilterCondition[];
  must_not?: QdrantFilterCondition[];
}

export class SearchModule {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    private readonly config: CodeConfig,
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
    let filter: QdrantFilter | undefined;
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
      const mustConditions: QdrantFilterCondition[] = [];
      filter = { must: mustConditions };

      // Basic filters
      if (options?.fileTypes && options.fileTypes.length > 0) {
        mustConditions.push({
          key: "fileExtension",
          match: { any: options.fileTypes },
        });
      }

      // Filter to documentation only (markdown, READMEs, etc.)
      if (options?.documentationOnly) {
        mustConditions.push({
          key: "isDocumentation",
          match: { value: true },
        });
      }

      // Git metadata filters (canonical algorithm: nested git.* keys)
      if (options?.author) {
        mustConditions.push({
          key: "git.dominantAuthor",
          match: { value: options.author },
        });
      }

      if (options?.modifiedAfter) {
        const timestamp = Math.floor(new Date(options.modifiedAfter).getTime() / 1000);
        mustConditions.push({
          key: "git.lastModifiedAt",
          range: { gte: timestamp },
        });
      }

      if (options?.modifiedBefore) {
        const timestamp = Math.floor(new Date(options.modifiedBefore).getTime() / 1000);
        mustConditions.push({
          key: "git.lastModifiedAt",
          range: { lte: timestamp },
        });
      }

      if (options?.minAgeDays !== undefined) {
        mustConditions.push({
          key: "git.ageDays",
          range: { gte: options.minAgeDays },
        });
      }

      if (options?.maxAgeDays !== undefined) {
        mustConditions.push({
          key: "git.ageDays",
          range: { lte: options.maxAgeDays },
        });
      }

      if (options?.minCommitCount !== undefined) {
        mustConditions.push({
          key: "git.commitCount",
          range: { gte: options.minCommitCount },
        });
      }

      if (options?.taskId) {
        mustConditions.push({
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
    let results: SearchResult[];
    if (useHybrid) {
      const sparseGenerator = new BM25SparseVectorGenerator();
      const sparseVector = sparseGenerator.generate(query);
      results = await this.qdrant.hybridSearch(
        collectionName,
        embedding,
        sparseVector,
        fetchLimit,
        filter as Record<string, unknown>,
      );
    } else {
      results = await this.qdrant.search(collectionName, embedding, fetchLimit, filter as Record<string, unknown>);
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
    return filteredResults.slice(0, requestedLimit).map((r) => {
      const payload = r.payload as Record<string, unknown> | undefined;
      const content = payload?.content;
      const relativePath = payload?.relativePath;
      const startLine = payload?.startLine;
      const endLine = payload?.endLine;
      const language = payload?.language;
      const fileExtension = payload?.fileExtension;
      const git = payload?.git;

      return {
        content: typeof content === "string" ? content : "",
        filePath: typeof relativePath === "string" ? relativePath : "",
        startLine: typeof startLine === "number" ? startLine : 0,
        endLine: typeof endLine === "number" ? endLine : 0,
        language: typeof language === "string" ? language : "unknown",
        score: r.score,
        fileExtension: typeof fileExtension === "string" ? fileExtension : "",
        // Include git metadata if it exists (file-level churn metrics)
        ...(git !== null && git !== undefined && typeof git === "object" ? { metadata: { git } } : {}),
      } as CodeSearchResult;
    });
  }
}
