/**
 * Tuning env snapshot for the project registry.
 *
 * Curated allowlist of the performance/behavior tuning env vars read by
 * `bootstrap/config/parse.ts` — canonical names AND their deprecated aliases,
 * so whichever spelling the operator actually exported is captured and later
 * replayed verbatim (envWithFallback resolves the same effective value).
 *
 * At index time the pipeline records the subset actually SET in the indexing
 * process env into `CollectionEntry.tuning` (GIT_ADAPTER excepted — always
 * recorded at its resolved value, see `captureTuningEnv`). Consumers launched
 * in a fresh
 * shell (CLI `index-codebase` worker, prime) re-apply the map registry-first
 * before building config, with explicit process env winning over the stored
 * value: env > registry > code default. Same mechanism as `codegraphEnabled`.
 *
 * Deliberately EXCLUDED: identity/endpoint config with dedicated
 * CollectionEntry fields (EMBEDDING_MODEL / EMBEDDING_BASE_URL / QDRANT_URL /
 * CODEGRAPH_ENABLED), server/transport knobs, and secrets (API keys).
 */
export const TUNING_ENV_ALLOWLIST: readonly string[] = [
  // vcs (parse.ts `vcs` section)
  "GIT_ADAPTER",
  // trajectoryGit (parse.ts `trajectoryGit` section)
  "TRAJECTORY_GIT_ENABLED",
  "CODE_ENABLE_GIT_METADATA",
  "TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS",
  "GIT_LOG_MAX_AGE_MONTHS",
  "TRAJECTORY_GIT_LOG_TIMEOUT_MS",
  "GIT_LOG_TIMEOUT_MS",
  "TRAJECTORY_GIT_CHUNK_CONCURRENCY",
  "GIT_CHUNK_CONCURRENCY",
  "TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS",
  "GIT_CHUNK_MAX_AGE_MONTHS",
  "TRAJECTORY_GIT_CHUNK_TIMEOUT_MS",
  "GIT_CHUNK_TIMEOUT_MS",
  "TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES",
  "GIT_CHUNK_MAX_FILE_LINES",
  "TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS",
  "TRAJECTORY_GIT_SESSION_GAP_MINUTES",
  // ingest.tune (parse.ts `ingestTune` section)
  "INGEST_PIPELINE_CONCURRENCY",
  "EMBEDDING_TUNE_CONCURRENCY",
  "EMBEDDING_CONCURRENCY",
  "INGEST_TUNE_CHUNKER_POOL_SIZE",
  "CHUNKER_POOL_SIZE",
  "INGEST_TUNE_FILE_CONCURRENCY",
  "FILE_PROCESSING_CONCURRENCY",
  "INGEST_TUNE_IO_CONCURRENCY",
  "MAX_IO_CONCURRENCY",
  "INGEST_TUNE_ENRICHMENT_POOL_SIZE",
  "ENRICHMENT_POOL_SIZE",
  // ingest chunking (parse.ts `ingest` section — sizes only, not feature flags)
  "INGEST_CHUNK_SIZE",
  "CODE_CHUNK_SIZE",
  "INGEST_CHUNK_OVERLAP",
  "CODE_CHUNK_OVERLAP",
  // embedding.tune (parse.ts `embeddingTune` section)
  "EMBEDDING_TUNE_BATCH_SIZE",
  "EMBEDDING_BATCH_SIZE",
  "CODE_BATCH_SIZE",
  "EMBEDDING_TUNE_MIN_BATCH_SIZE",
  "MIN_BATCH_SIZE",
  "EMBEDDING_TUNE_BATCH_TIMEOUT_MS",
  "BATCH_FORMATION_TIMEOUT_MS",
  "EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE",
  "EMBEDDING_MAX_REQUESTS_PER_MINUTE",
  "EMBEDDING_TUNE_RETRY_ATTEMPTS",
  "EMBEDDING_RETRY_ATTEMPTS",
  "EMBEDDING_TUNE_RETRY_DELAY_MS",
  "EMBEDDING_RETRY_DELAY",
  "EMBEDDING_TUNE_HEALTH_CHECK_RETRY_ATTEMPTS",
  "EMBEDDING_HEALTH_CHECK_RETRY_ATTEMPTS",
  "EMBEDDING_TUNE_HEALTH_CHECK_RETRY_DELAY_MS",
  "EMBEDDING_HEALTH_CHECK_RETRY_DELAY_MS",
  "EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS",
  "EMBEDDING_UNAVAILABLE_RETRY_MAX_WAIT_MS",
  "EMBEDDING_TUNE_UNAVAILABLE_RETRY_BASE_DELAY_MS",
  "EMBEDDING_UNAVAILABLE_RETRY_BASE_DELAY_MS",
  // qdrantTune (parse.ts `qdrantTune` section)
  "QDRANT_TUNE_UPSERT_BATCH_SIZE",
  "QDRANT_UPSERT_BATCH_SIZE",
  "QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS",
  "QDRANT_FLUSH_INTERVAL_MS",
  "QDRANT_TUNE_UPSERT_ORDERING",
  "QDRANT_BATCH_ORDERING",
  "QDRANT_TUNE_DELETE_BATCH_SIZE",
  "QDRANT_DELETE_BATCH_SIZE",
  "DELETE_BATCH_SIZE",
  "QDRANT_TUNE_DELETE_CONCURRENCY",
  "QDRANT_DELETE_CONCURRENCY",
  "DELETE_CONCURRENCY",
  "QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS",
  "DELETE_FLUSH_TIMEOUT_MS",
  "QDRANT_QUANTIZATION_SCALAR",
  "QDRANT_TURBO_QUANT",
  "QDRANT_MAX_RESIDENT_MEMORY_PERCENT",
  "QDRANT_SEARCH_MAX_BATCHSIZE",
  "QDRANT_LOW_MEMORY",
];

/**
 * Snapshot the allowlisted tuning vars actually SET in the given env.
 * Empty-string values are skipped — `envWithFallback` treats them as unset,
 * so recording them would materialize nothing.
 *
 * Exception: GIT_ADAPTER is ALWAYS included at its RESOLVED value, even when
 * the env var is unset (spec decision: the adapter choice is pinned
 * per-project explicitly; ambient env must not silently flip it on a later
 * run). Every other key keeps the only-when-set behavior, so the snapshot is
 * never undefined anymore — it carries at least the pinned GIT_ADAPTER.
 */
export function captureTuningEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const tuning: Record<string, string> = {};
  for (const key of TUNING_ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined && value !== "") tuning[key] = value;
  }
  // Deliberate force-pin: resolved default materialized when unset/empty.
  tuning.GIT_ADAPTER ??= "git";
  return tuning;
}
