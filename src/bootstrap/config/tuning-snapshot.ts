/**
 * buildTuningEnvSnapshot — the full effective tuning env set of this run,
 * keyed by CANONICAL env names, for persistence into the project registry
 * (tea-rags-mcp-9vpnz).
 *
 * Built from the PARSED zod config rather than process.env so code defaults
 * (including provider-conditional ones) materialize at their true effective
 * values — the registry snapshot is complete and self-sufficient: a bare-env
 * `tea-rags index-codebase` reproduces the last run's configuration even if
 * a later tea-rags version changes a code default.
 *
 * Two deliberate gaps:
 * - ADAPTIVE_DEFAULT_TUNING_KEYS (GPU-calibrated batch size, per-language
 *   chunk sizing, embedded-mode delete tuning) are included only when the
 *   user explicitly set them — the config layer marks exactly those four via
 *   its `userSet*` flags. Pinning an adaptive value would freeze behavior
 *   the default recomputes per run (e.g. one chunk size for all languages).
 * - Optional knobs with no code default (min batch size, request-rate cap,
 *   strict-mode guards) are skipped while unset — there is no value to pin.
 *
 * Injected into the ingest pipeline via DI (like `teaRagsVersion`) and
 * written by `recordRegistryEntry` on every successful index.
 */

import type { EmbeddingConfig, QdrantTuneConfig, TrajectoryGitConfig, VcsConfig } from "../../core/contracts/index.js";
import type { IngestConfig } from "./schemas.js";

export interface TuningSnapshotSource {
  vcs: VcsConfig;
  trajectoryGit: TrajectoryGitConfig;
  ingest: IngestConfig;
  embedding: EmbeddingConfig;
  qdrantTune: QdrantTuneConfig;
  flags: {
    userSetBatchSize: boolean;
    userSetChunkSize: boolean;
    userSetDeleteBatchSize: boolean;
    userSetDeleteConcurrency: boolean;
  };
}

export function buildTuningEnvSnapshot(config: TuningSnapshotSource): Record<string, string> {
  const { vcs, trajectoryGit, ingest, embedding, qdrantTune, flags } = config;
  const snapshot: Record<string, string> = {};
  const put = (key: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined) snapshot[key] = String(value);
  };

  put("GIT_ADAPTER", vcs.adapter);

  put("TRAJECTORY_GIT_ENABLED", trajectoryGit.enabled);
  put("TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS", trajectoryGit.logMaxAgeMonths);
  put("TRAJECTORY_GIT_LOG_TIMEOUT_MS", trajectoryGit.logTimeoutMs);
  put("TRAJECTORY_GIT_CHUNK_CONCURRENCY", trajectoryGit.chunkConcurrency);
  put("TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS", trajectoryGit.chunkMaxAgeMonths);
  put("TRAJECTORY_GIT_CHUNK_TIMEOUT_MS", trajectoryGit.chunkTimeoutMs);
  put("TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES", trajectoryGit.chunkMaxFileLines);
  put("TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS", trajectoryGit.squashAwareSessions);
  put("TRAJECTORY_GIT_SESSION_GAP_MINUTES", trajectoryGit.sessionGapMinutes);

  put("INGEST_PIPELINE_CONCURRENCY", ingest.tune.pipelineConcurrency);
  put("INGEST_TUNE_CHUNKER_POOL_SIZE", ingest.tune.chunkerPoolSize);
  put("INGEST_TUNE_FILE_CONCURRENCY", ingest.tune.fileConcurrency);
  put("INGEST_TUNE_IO_CONCURRENCY", ingest.tune.ioConcurrency);
  put("INGEST_TUNE_ENRICHMENT_POOL_SIZE", ingest.tune.enrichmentPoolSize);
  if (flags.userSetChunkSize) put("INGEST_CHUNK_SIZE", ingest.chunkSize);
  put("INGEST_CHUNK_OVERLAP", ingest.chunkOverlap);

  if (flags.userSetBatchSize) put("EMBEDDING_TUNE_BATCH_SIZE", embedding.tune.batchSize);
  put("EMBEDDING_TUNE_MIN_BATCH_SIZE", embedding.tune.minBatchSize);
  put("EMBEDDING_TUNE_BATCH_TIMEOUT_MS", embedding.tune.batchTimeoutMs);
  put("EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE", embedding.tune.maxRequestsPerMinute);
  put("EMBEDDING_TUNE_RETRY_ATTEMPTS", embedding.tune.retryAttempts);
  put("EMBEDDING_TUNE_RETRY_DELAY_MS", embedding.tune.retryDelayMs);
  put("EMBEDDING_TUNE_HEALTH_CHECK_RETRY_ATTEMPTS", embedding.tune.healthCheckRetryAttempts);
  put("EMBEDDING_TUNE_HEALTH_CHECK_RETRY_DELAY_MS", embedding.tune.healthCheckRetryDelayMs);
  put("EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS", embedding.tune.unavailableRetryMaxWaitMs);
  put("EMBEDDING_TUNE_UNAVAILABLE_RETRY_BASE_DELAY_MS", embedding.tune.unavailableRetryBaseDelayMs);

  put("QDRANT_TUNE_UPSERT_BATCH_SIZE", qdrantTune.upsertBatchSize);
  put("QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS", qdrantTune.upsertFlushIntervalMs);
  put("QDRANT_TUNE_UPSERT_ORDERING", qdrantTune.upsertOrdering);
  if (flags.userSetDeleteBatchSize) put("QDRANT_TUNE_DELETE_BATCH_SIZE", qdrantTune.deleteBatchSize);
  if (flags.userSetDeleteConcurrency) put("QDRANT_TUNE_DELETE_CONCURRENCY", qdrantTune.deleteConcurrency);
  put("QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS", qdrantTune.deleteFlushTimeoutMs);
  put("QDRANT_QUANTIZATION_SCALAR", qdrantTune.quantizationScalar);
  put("QDRANT_TURBO_QUANT", qdrantTune.turboQuant);
  put("QDRANT_MAX_RESIDENT_MEMORY_PERCENT", qdrantTune.maxResidentMemoryPercent);
  put("QDRANT_SEARCH_MAX_BATCHSIZE", qdrantTune.searchMaxBatchsize);
  put("QDRANT_LOW_MEMORY", qdrantTune.lowMemory);

  return snapshot;
}
