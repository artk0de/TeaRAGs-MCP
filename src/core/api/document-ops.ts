/**
 * Document add/delete operations — business logic extracted from MCP handlers.
 */

import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import { BM25SparseVectorGenerator } from "../adapters/qdrant/sparse.js";
import type { AddDocumentsRequest, DeleteDocumentsRequest } from "./app.js";

export class DocumentOps {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async add(request: AddDocumentsRequest): Promise<{ count: number }> {
    const { collection, documents } = request;

    // 1. Check collection exists
    const exists = await this.qdrant.collectionExists(collection);
    if (!exists) {
      throw new Error(`Collection "${collection}" does not exist. Create it first using create_collection.`);
    }

    // 2. Get collection info for hybrid check
    const collectionInfo = await this.qdrant.getCollectionInfo(collection);

    // 3. Embed all document texts
    const texts = documents.map((doc) => doc.text);
    const embeddingResults = await this.embeddings.embedBatch(texts);

    // 4. Add points — with or without sparse vectors
    if (collectionInfo.hybridEnabled) {
      const sparseGenerator = new BM25SparseVectorGenerator();

      const points = documents.map((doc, index) => ({
        id: doc.id,
        vector: embeddingResults[index].embedding,
        sparseVector: sparseGenerator.generate(doc.text),
        payload: {
          text: doc.text,
          ...doc.metadata,
        },
      }));

      await this.qdrant.addPointsWithSparse(collection, points);
    } else {
      const points = documents.map((doc, index) => ({
        id: doc.id,
        vector: embeddingResults[index].embedding,
        payload: {
          text: doc.text,
          ...doc.metadata,
        },
      }));

      await this.qdrant.addPoints(collection, points);
    }

    // 5. Return count
    return { count: documents.length };
  }

  async delete(request: DeleteDocumentsRequest): Promise<{ count: number }> {
    await this.qdrant.deletePoints(request.collection, request.ids);
    return { count: request.ids.length };
  }
}
