/**
 * CodeIndexer - Main orchestrator for code vectorization
 *
 * Facade that delegates to extracted modules:
 * - EnrichmentModule: background git metadata enrichment
 * - IndexingModule: full codebase indexing from scratch
 * - SearchModule: semantic code search
 * - StatusModule: index status queries and cleanup
 * - ReindexModule: incremental re-indexing of changed files
 */

import type { EmbeddingProvider } from "../embeddings/base.js";
import type { QdrantManager } from "../qdrant/client.js";
import { EnrichmentModule } from "./indexer/enrichment-module.js";
import { IndexingModule } from "./indexer/indexing-module.js";
import { ReindexModule } from "./indexer/reindex-module.js";
import { SearchModule } from "./indexer/search-module.js";
import { resolveCollectionName } from "./indexer/shared.js";
import { StatusModule } from "./indexer/status-module.js";
import type {
  ChangeStats,
  CodeConfig,
  CodeSearchResult,
  IndexOptions,
  IndexStats,
  IndexStatus,
  ProgressCallback,
  SearchOptions,
} from "./types.js";

export class CodeIndexer {
  private readonly enrichment: EnrichmentModule;
  private readonly indexing: IndexingModule;
  private readonly search: SearchModule;
  private readonly status: StatusModule;
  private readonly reindex: ReindexModule;

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    private readonly config: CodeConfig,
  ) {
    this.enrichment = new EnrichmentModule(this.qdrant);
    this.indexing = new IndexingModule(this.qdrant, this.embeddings, this.config, this.enrichment);
    this.search = new SearchModule(this.qdrant, this.embeddings, this.config);
    this.status = new StatusModule(this.qdrant);
    this.reindex = new ReindexModule(this.qdrant, this.embeddings, this.config, this.enrichment);
  }

  /**
   * Index a codebase from scratch or force re-index
   */
  async indexCodebase(path: string, options?: IndexOptions, progressCallback?: ProgressCallback): Promise<IndexStats> {
    return this.indexing.indexCodebase(path, options, progressCallback);
  }

  /**
   * Search code semantically
   */
  async searchCode(path: string, query: string, options?: SearchOptions): Promise<CodeSearchResult[]> {
    return this.search.searchCode(path, query, options);
  }

  /**
   * Get indexing status for a codebase
   */
  async getIndexStatus(path: string): Promise<IndexStatus> {
    return this.status.getIndexStatus(path);
  }

  /**
   * Incrementally re-index only changed files
   */
  async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
    return this.reindex.reindexChanges(path, progressCallback);
  }

  /**
   * Clear all indexed data for a codebase
   */
  async clearIndex(path: string): Promise<void> {
    return this.status.clearIndex(path);
  }

  /** Generate deterministic collection name from codebase path */
  private getCollectionName(path: string): string {
    return resolveCollectionName(path);
  }

  /** Static utility to generate collection name from path. */
  static resolveCollectionName(path: string): string {
    return resolveCollectionName(path);
  }
}
