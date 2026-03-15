/**
 * Collection CRUD operations — business logic extracted from MCP handlers.
 */

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { CollectionInfo, CreateCollectionRequest } from "../../public/dto/index.js";

export class CollectionOps {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    private readonly quantizationScalar: boolean,
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

    return {
      name: request.name,
      vectorSize,
      pointsCount: 0,
      distance: request.distance || "Cosine",
      hybridEnabled: enableHybrid,
    };
  }

  async list(): Promise<string[]> {
    return this.qdrant.listCollections();
  }

  async getInfo(name: string): Promise<CollectionInfo> {
    return this.qdrant.getCollectionInfo(name);
  }

  async delete(name: string): Promise<void> {
    await this.qdrant.deleteCollection(name);
  }
}
