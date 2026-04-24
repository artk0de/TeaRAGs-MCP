import type { QdrantTuneConfig } from "../../core/contracts/types/config.js";

/**
 * Embedded Qdrant serializes all writes through a single WAL. Parallel
 * delete-by-filter requests don't execute in parallel — they queue behind the
 * same WAL channel while still occupying HTTP-client slots, starving upsert
 * batches that would otherwise flow from ChunkPipeline. Override delete tuning
 * to a single, smaller batch so the HTTP client is free between delete calls
 * and upserts can interleave.
 *
 * Remote Qdrant (cluster, multi-thread) benefits from parallelism — leave
 * defaults untouched. User-set env vars always win.
 */
export function applyEmbeddedDeleteTuning(
  tune: QdrantTuneConfig,
  mode: "embedded" | "external",
  userSet: { deleteBatchSize: boolean; deleteConcurrency: boolean },
): QdrantTuneConfig {
  if (mode !== "embedded") return tune;
  return {
    ...tune,
    deleteBatchSize: userSet.deleteBatchSize ? tune.deleteBatchSize : 200,
    deleteConcurrency: userSet.deleteConcurrency ? tune.deleteConcurrency : 1,
  };
}
