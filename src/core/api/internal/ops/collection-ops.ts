/**
 * Collection CRUD operations — business logic extracted from MCP handlers.
 */

import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { EmbeddingModelGuard } from "../../../infra/embedding-model-guard.js";
import type { CollectionInfo, CreateCollectionRequest } from "../../public/dto/index.js";

export class CollectionOps {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    private readonly quantizationScalar: boolean,
    private readonly modelGuard?: EmbeddingModelGuard,
    private readonly codegraphPool?: GraphDbClientPool,
  ) {}

  async create(request: CreateCollectionRequest): Promise<CollectionInfo> {
    const vectorSize = this.embeddings.getDimensions();
    const enableHybrid = request.enableHybrid || false;

    await this.qdrant.createCollection(
      request.name,
      vectorSize,
      request.distance,
      enableHybrid,
      this.quantizationScalar,
    );

    this.modelGuard?.recordModel(request.name);

    return {
      name: request.name,
      vectorSize,
      pointsCount: 0,
      distance: request.distance || "Cosine",
      hybridEnabled: enableHybrid,
      status: "green",
      optimizerStatus: "ok",
    };
  }

  async list(): Promise<string[]> {
    return this.qdrant.listCollections();
  }

  async getInfo(name: string): Promise<CollectionInfo> {
    return this.qdrant.getCollectionInfo(name);
  }

  /**
   * Delete a collection in Qdrant AND drop the per-collection codegraph
   * DuckDB file (when codegraph is wired). Order matters: Qdrant first
   * — if it fails we keep the DuckDB file so a retry doesn't lose
   * symbol state that still has a live collection it shadows. After
   * Qdrant succeeds, codegraph cleanup is best-effort — failure to
   * unlink the DuckDB file is non-fatal and surfaces via the typed
   * `DuckDbCloseFailedError`.
   */
  async delete(name: string): Promise<void> {
    await this.qdrant.deleteCollection(name);
    if (this.codegraphPool) {
      await this.codegraphPool.removeCollection(name);
    }
  }
}
