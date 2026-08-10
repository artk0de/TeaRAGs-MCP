/**
 * Payload FIELD indexes — the secondary indexes Qdrant needs before a filter on
 * `relativePath`, `language`, `codegraph.symbols.file.fanIn`, … does anything
 * other than a full scan.
 *
 * Separate from `QdrantCollectionAdmin` because the lifecycle is different: a
 * collection is created once, whereas its field indexes are reconciled on every
 * startup by the schema migration (`schema-manager.ts`), which is why the
 * check-then-create pair is expressed here as one idempotent
 * {@link QdrantPayloadIndexManager.ensurePayloadIndex} rather than left to each
 * caller to reassemble.
 */

import type { QdrantConnection } from "./connection.js";
import { QdrantUnavailableError } from "./errors.js";

export class QdrantPayloadIndexManager {
  constructor(private readonly connection: QdrantConnection) {}

  /**
   * Create a payload index on a field for faster filtering.
   * Supported schemas: "keyword", "integer", "float", "bool", "geo", "datetime", "text", "uuid"
   *
   * IMPORTANT: Indexes should be created immediately after collection setup.
   * Creating them on large existing collections may be slow and block updates.
   */
  async createPayloadIndex(
    collectionName: string,
    fieldName: string,
    fieldSchema: "keyword" | "integer" | "float" | "bool" | "geo" | "datetime" | "text" | "uuid",
  ): Promise<void> {
    await this.connection.call(async () =>
      this.connection.client.createPayloadIndex(collectionName, {
        field_name: fieldName,
        field_schema: fieldSchema,
        wait: true,
      }),
    );
  }

  /**
   * Check if a payload index exists on a field.
   */
  async hasPayloadIndex(collectionName: string, fieldName: string): Promise<boolean> {
    try {
      const info = await this.connection.call(async () => this.connection.client.getCollection(collectionName));
      const indexes = info.payload_schema || {};
      return fieldName in indexes;
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
      return false;
    }
  }

  /**
   * Ensure a payload index exists, creating it if missing.
   * Returns true if index was created, false if already existed.
   */
  async ensurePayloadIndex(
    collectionName: string,
    fieldName: string,
    fieldSchema: "keyword" | "integer" | "float" | "bool" | "geo" | "datetime" | "text" | "uuid",
  ): Promise<boolean> {
    const exists = await this.hasPayloadIndex(collectionName, fieldName);
    if (exists) {
      return false;
    }
    await this.createPayloadIndex(collectionName, fieldName, fieldSchema);
    return true;
  }
}
