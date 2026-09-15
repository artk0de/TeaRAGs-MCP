/**
 * EnrichmentStoreAdapter — adapts QdrantManager to the EnrichmentStore interface.
 *
 * Handles enrichedAt backfill migration: scrolls chunks, batch-sets payload,
 * and tracks migration completion via marker on the indexing metadata point.
 */

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import { chunkPointsFilter } from "../../../../adapters/qdrant/service-points.js";
import { INDEXING_METADATA_ID } from "../../../../contracts/constants.js";
import type { EnrichmentStore } from "../types.js";

const SCROLL_LIMIT = 50_000;
const MIGRATION_KEY = "enrichmentMigrationV1";

export class EnrichmentStoreAdapter implements EnrichmentStore {
  constructor(private readonly qdrant: QdrantManager) {}

  async isMigrated(collection: string): Promise<boolean> {
    const metadata = await this.qdrant.getPoint(collection, INDEXING_METADATA_ID);
    return metadata?.payload?.[MIGRATION_KEY] === true;
  }

  async scrollAllChunks(collection: string): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    const points = await this.qdrant.scrollFiltered(collection, chunkPointsFilter(), SCROLL_LIMIT);
    return points.map((p) => ({
      id: p.id,
      payload: p.payload ?? {},
    }));
  }

  async batchSetPayload(
    collection: string,
    operations: { payload: Record<string, unknown>; points: (string | number)[]; key?: string }[],
  ): Promise<void> {
    await this.qdrant.batchSetPayload(collection, operations);
  }

  async markMigrated(collection: string): Promise<void> {
    await this.qdrant.setPayload(collection, { [MIGRATION_KEY]: true }, { points: [INDEXING_METADATA_ID] });
  }
}
