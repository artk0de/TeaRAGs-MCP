/**
 * EnrichmentStoreAdapter — adapts QdrantManager to the EnrichmentStore interface.
 *
 * Handles enrichedAt backfill migration: scrolls chunks, batch-sets payload,
 * and tracks migration completion via marker on the indexing metadata point.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { INDEXING_METADATA_ID } from "../../../domains/ingest/constants.js";
import type { EnrichmentStore } from "../types.js";

const SCROLL_LIMIT = 50_000;
const MIGRATION_KEY = "enrichmentMigrationV1";

export class EnrichmentStoreAdapter implements EnrichmentStore {
  constructor(private readonly qdrant: QdrantManager) {}

  async isMigrated(collection: string): Promise<boolean> {
    const metadata = await this.qdrant.getPoint(collection, INDEXING_METADATA_ID);
    return metadata?.payload?.[MIGRATION_KEY] === true;
  }

  async scrollAllChunks(
    collection: string,
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    const filter = { must_not: [{ has_id: [INDEXING_METADATA_ID] }] };
    const points = await this.qdrant.scrollFiltered(collection, filter, SCROLL_LIMIT);
    return points.map((p) => ({
      id: p.id,
      payload: (p.payload ?? {}) as Record<string, unknown>,
    }));
  }

  async batchSetPayload(
    collection: string,
    operations: { payload: Record<string, unknown>; points: (string | number)[] }[],
  ): Promise<void> {
    await this.qdrant.batchSetPayload(collection, operations);
  }

  async markMigrated(collection: string): Promise<void> {
    await this.qdrant.setPayload(
      collection,
      { [MIGRATION_KEY]: true },
      { points: [INDEXING_METADATA_ID] },
    );
  }
}
