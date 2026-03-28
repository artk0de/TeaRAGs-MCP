/**
 * EnrichmentMigration — one-time backfill of enrichedAt timestamps for existing collections.
 *
 * Scrolls all chunks in a collection and adds `{providerKey}.file.enrichedAt` or
 * `{providerKey}.chunk.enrichedAt` to chunks that have git signals but no enrichedAt timestamp.
 * Idempotent: guarded by `enrichmentMigrationV1` marker on the metadata point.
 */

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import { INDEXING_METADATA_ID } from "../../constants.js";

const SCROLL_LIMIT = 50_000;
const BATCH_SIZE = 100;

export class EnrichmentMigration {
  constructor(private readonly qdrant: QdrantManager) {}

  async migrateEnrichedAt(collectionName: string, providerKey: string): Promise<void> {
    // Step 1: idempotency check
    const metadata = await this.qdrant.getPoint(collectionName, INDEXING_METADATA_ID);
    if (metadata?.payload?.enrichmentMigrationV1 === true) {
      return;
    }

    // Step 2: scroll all non-metadata chunks
    const filter = {
      must_not: [{ has_id: [INDEXING_METADATA_ID] }],
    };

    const points = await this.qdrant.scrollFiltered(collectionName, filter, SCROLL_LIMIT);

    // Step 3: categorize chunks
    const now = new Date().toISOString();
    const fileOps: { payload: Record<string, unknown>; points: (string | number)[] }[] = [];
    const chunkOps: { payload: Record<string, unknown>; points: (string | number)[] }[] = [];

    for (const point of points) {
      const gitPayload = point.payload?.[providerKey] as Record<string, unknown> | undefined;
      const fileSignals = gitPayload?.file as Record<string, unknown> | undefined;
      const chunkSignals = gitPayload?.chunk as Record<string, unknown> | undefined;

      if (fileSignals?.commitCount !== undefined) {
        fileOps.push({
          payload: { [`${providerKey}.file.enrichedAt`]: now },
          points: [point.id],
        });
      }

      if (chunkSignals?.commitCount !== undefined) {
        chunkOps.push({
          payload: { [`${providerKey}.chunk.enrichedAt`]: now },
          points: [point.id],
        });
      }
    }

    // Step 4: write batches
    const allOps = [...fileOps, ...chunkOps];
    if (allOps.length > 0) {
      for (let i = 0; i < allOps.length; i += BATCH_SIZE) {
        await this.qdrant.batchSetPayload(collectionName, allOps.slice(i, i + BATCH_SIZE));
      }
    }

    // Step 5: write migration marker
    await this.qdrant.setPayload(
      collectionName,
      { enrichmentMigrationV1: true },
      { points: [INDEXING_METADATA_ID] },
    );
  }
}
