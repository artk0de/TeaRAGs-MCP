/**
 * Document add/delete operations — business logic extracted from MCP handlers.
 */

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { EmbeddingModelGuard } from "../../../adapters/qdrant/embedding-model-guard.js";
import { generateSparseVector } from "../../../adapters/qdrant/sparse.js";
import { CollectionNotFoundError } from "../../../domains/explore/errors.js";
import type { AddDocumentsRequest, DeleteDocumentsRequest } from "../../public/dto/index.js";
import { DocumentMetadataSchemaCompiler, readDocumentMetadataSchema } from "./document-metadata-schema.js";

export class DocumentOps {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    private readonly modelGuard?: EmbeddingModelGuard,
    private readonly metadataSchemas: DocumentMetadataSchemaCompiler = new DocumentMetadataSchemaCompiler(),
  ) {}

  async add(request: AddDocumentsRequest): Promise<{ count: number }> {
    const { collection } = request;

    // 1. Check collection exists
    const exists = await this.qdrant.collectionExists(collection);
    if (!exists) {
      throw new CollectionNotFoundError(collection);
    }

    // 2. Verify embedding model matches
    await this.modelGuard?.ensureMatch(collection);

    // 2. Get collection info for hybrid check and the typed-collection schema
    const collectionInfo = await this.qdrant.getCollectionInfo(collection);

    // 3. Typed collection: validate the whole batch before anything is
    //    embedded — one violation rejects every document.
    const documents = this.validateMetadata(collection, request.documents, collectionInfo.metadata);

    // 4. Embed all document texts
    const texts = documents.map((doc) => doc.text);
    const embeddingResults = await this.embeddings.embedBatch(texts);

    // 5. Add points — with or without sparse vectors
    if (collectionInfo.hybridEnabled) {
      const points = documents.map((doc, index) => ({
        id: doc.id,
        vector: embeddingResults[index].embedding,
        sparseVector: generateSparseVector(doc.text),
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

    // 6. Return count
    return { count: documents.length };
  }

  /**
   * Untyped collection: documents pass through unchanged. Typed collection:
   * each document's metadata is replaced by its parsed form, so schema
   * defaults reach the stored payload.
   */
  private validateMetadata(
    collection: string,
    documents: AddDocumentsRequest["documents"],
    collectionMetadata: Record<string, unknown> | undefined,
  ): AddDocumentsRequest["documents"] {
    const schema = readDocumentMetadataSchema(collectionMetadata);
    if (!schema) return documents;
    const parsed = this.metadataSchemas.compile(schema).parseBatch(collection, documents);
    return documents.map((doc, index) => ({ ...doc, metadata: parsed[index] }));
  }

  async delete(request: DeleteDocumentsRequest): Promise<{ count: number }> {
    await this.qdrant.deletePoints(request.collection, request.ids);
    return { count: request.ids.length };
  }
}
