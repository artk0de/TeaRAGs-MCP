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

import { InfraError } from "../errors.js";
import type { QdrantConnection } from "./connection.js";
import { QdrantOperationError, QdrantUnavailableError } from "./errors.js";
import { foldUpdateStatus } from "./write-barrier.js";

/**
 * One payload field index as Qdrant reports it in a collection's
 * `payload_schema`. `points` counts the points whose payload carries a value
 * under the key — zero for an index nothing writes into, which is NOT the same
 * as an index nothing needs (`git.file.skippedAs` is legitimately empty).
 */
export interface PayloadFieldIndex {
  field: string;
  dataType: string;
  points: number;
}

export class QdrantPayloadIndexManager {
  /**
   * `onUnconfirmedIndex` runs when a waited creation answered `wait_timeout`:
   * the index may still be building, and what to do about that (confirm it
   * through the write barrier, log it) belongs to the manager that owns the
   * barrier budget. It must not throw — a slow index never fails indexing.
   */
  constructor(
    private readonly connection: QdrantConnection,
    private readonly onUnconfirmedIndex: (collectionName: string, fieldName: string) => Promise<void> = async () => {},
  ) {}

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
    const result = await this.connection.call(async () =>
      this.connection.client.createPayloadIndex(collectionName, {
        field_name: fieldName,
        field_schema: fieldSchema,
        wait: true,
      }),
    );
    // `wait_timeout`: the index is still being built (bd tea-rags-mcp-wjyaf).
    if (foldUpdateStatus(result) === "wait_timeout") await this.onUnconfirmedIndex(collectionName, fieldName);
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

  /**
   * Every payload field index the collection carries.
   *
   * Unlike {@link hasPayloadIndex}, a failure propagates: a caller deciding
   * which indexes to drop must never read "the schema was unreadable" as "the
   * collection has no indexes".
   */
  async listPayloadIndexes(collectionName: string): Promise<PayloadFieldIndex[]> {
    const info = await this.callTyped("listPayloadIndexes", collectionName, async () =>
      this.connection.client.getCollection(collectionName),
    );
    return Object.entries(info.payload_schema ?? {}).map(([field, schema]) => ({
      field,
      dataType: String(schema?.data_type),
      points: schema?.points ?? 0,
    }));
  }

  /** Drop the index on one payload field; the payload values themselves are untouched. */
  async deletePayloadIndex(collectionName: string, fieldName: string): Promise<void> {
    await this.callTyped("deletePayloadIndex", collectionName, async () =>
      this.connection.client.deletePayloadIndex(collectionName, fieldName, { wait: true }),
    );
  }

  /**
   * Run a client call through the connection, keeping a typed infra failure
   * (unavailable / starting / recovering) as it is and turning anything else
   * the client raised into a {@link QdrantOperationError}.
   */
  private async callTyped<T>(operation: string, collectionName: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.connection.call(fn);
    } catch (error: unknown) {
      if (error instanceof InfraError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new QdrantOperationError(
        operation,
        `collection "${collectionName}": ${String(cause?.message ?? error)}`,
        cause,
      );
    }
  }
}
