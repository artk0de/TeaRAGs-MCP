/**
 * IngestFacade - Public API for codebase indexing operations.
 *
 * Delegates to:
 * - IndexPipeline: full codebase indexing from scratch
 * - ReindexPipeline: incremental re-indexing of changed files
 * - StatusModule: index status queries and cleanup
 * - EnrichmentModule: background git metadata enrichment
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import { createIngestDependencies } from "../ingest/factory.js";
import { IndexPipeline } from "../ingest/indexing.js";
import { ReindexPipeline } from "../ingest/reindexing.js";
import { StatusModule } from "../ingest/status-module.js";
import { EnrichmentModule } from "../ingest/trajectory/enrichment-module.js";
import type { ChangeStats, CodeConfig, IndexOptions, IndexStats, IndexStatus, ProgressCallback } from "../types.js";

export class IngestFacade {
  private readonly enrichment: EnrichmentModule;
  private readonly indexing: IndexPipeline;
  private readonly status: StatusModule;
  private readonly reindex: ReindexPipeline;

  constructor(qdrant: QdrantManager, embeddings: EmbeddingProvider, config: CodeConfig) {
    const snapshotDir = join(homedir(), ".tea-rags-mcp", "snapshots");
    const deps = createIngestDependencies(qdrant, snapshotDir);

    this.enrichment = new EnrichmentModule(qdrant);
    this.indexing = new IndexPipeline(qdrant, embeddings, config, this.enrichment, deps);
    this.status = new StatusModule(qdrant);
    this.reindex = new ReindexPipeline(qdrant, embeddings, config, this.enrichment, deps);
  }

  /** Index a codebase from scratch or force re-index */
  async indexCodebase(path: string, options?: IndexOptions, progressCallback?: ProgressCallback): Promise<IndexStats> {
    return this.indexing.indexCodebase(path, options, progressCallback);
  }

  /** Incrementally re-index only changed files */
  async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
    return this.reindex.reindexChanges(path, progressCallback);
  }

  /** Get indexing status for a codebase */
  async getIndexStatus(path: string): Promise<IndexStatus> {
    return this.status.getIndexStatus(path);
  }

  /** Clear all indexed data for a codebase */
  async clearIndex(path: string): Promise<void> {
    return this.status.clearIndex(path);
  }
}
