/**
 * Tuning env vocabulary for the project registry snapshot.
 *
 * Each group mirrors one alias family read by `bootstrap/config/parse.ts`:
 * the CANONICAL env name plus its deprecated spellings, resolved by
 * `envWithFallback` in that order. The snapshot builder
 * (`bootstrap/config/tuning-snapshot.ts`) emits one canonical key per group
 * at its parsed effective value — code defaults materialized — so the
 * registry carries the FULL set of tuning envs the indexing run lived with,
 * and a bare-env CLI reindex reproduces the last run's configuration.
 *
 * Replay (`cli/registry-env-replay.ts`) applies the map registry-first with
 * env > registry > code default precedence PER GROUP: an externally-set
 * value in ANY spelling of a group beats the stored canonical key, so a
 * deprecated alias passed on the command line still overrides the registry.
 *
 * Deliberately EXCLUDED: identity/endpoint config with dedicated
 * CollectionEntry fields (EMBEDDING_MODEL / EMBEDDING_BASE_URL / QDRANT_URL /
 * CODEGRAPH_ENABLED), server/transport knobs, and secrets (API keys).
 */

/** One alias family: the canonical env name plus its deprecated spellings. */
export interface TuningEnvGroup {
  canonical: string;
  aliases: readonly string[];
}

export const TUNING_ENV_GROUPS: readonly TuningEnvGroup[] = [
  // vcs (parse.ts `vcs` section)
  { canonical: "GIT_ADAPTER", aliases: [] },
  // trajectoryGit (parse.ts `trajectoryGit` section)
  { canonical: "TRAJECTORY_GIT_ENABLED", aliases: ["CODE_ENABLE_GIT_METADATA"] },
  { canonical: "TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS", aliases: ["GIT_LOG_MAX_AGE_MONTHS"] },
  { canonical: "TRAJECTORY_GIT_LOG_TIMEOUT_MS", aliases: ["GIT_LOG_TIMEOUT_MS"] },
  { canonical: "TRAJECTORY_GIT_CHUNK_CONCURRENCY", aliases: ["GIT_CHUNK_CONCURRENCY"] },
  { canonical: "TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS", aliases: ["GIT_CHUNK_MAX_AGE_MONTHS"] },
  { canonical: "TRAJECTORY_GIT_CHUNK_TIMEOUT_MS", aliases: ["GIT_CHUNK_TIMEOUT_MS"] },
  { canonical: "TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES", aliases: ["GIT_CHUNK_MAX_FILE_LINES"] },
  { canonical: "TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS", aliases: [] },
  { canonical: "TRAJECTORY_GIT_SESSION_GAP_MINUTES", aliases: [] },
  // ingest.tune (parse.ts `ingestTune` section)
  { canonical: "INGEST_PIPELINE_CONCURRENCY", aliases: ["EMBEDDING_TUNE_CONCURRENCY", "EMBEDDING_CONCURRENCY"] },
  { canonical: "INGEST_TUNE_CHUNKER_POOL_SIZE", aliases: ["CHUNKER_POOL_SIZE"] },
  { canonical: "INGEST_TUNE_FILE_CONCURRENCY", aliases: ["FILE_PROCESSING_CONCURRENCY"] },
  { canonical: "INGEST_TUNE_IO_CONCURRENCY", aliases: ["MAX_IO_CONCURRENCY"] },
  { canonical: "INGEST_TUNE_ENRICHMENT_POOL_SIZE", aliases: ["ENRICHMENT_POOL_SIZE"] },
  // ingest chunking (parse.ts `ingest` section — sizes only, not feature flags)
  { canonical: "INGEST_CHUNK_SIZE", aliases: ["CODE_CHUNK_SIZE"] },
  { canonical: "INGEST_CHUNK_OVERLAP", aliases: ["CODE_CHUNK_OVERLAP"] },
  // embedding.tune (parse.ts `embeddingTune` section). CODE_BATCH_SIZE is a
  // member of TWO groups — parse.ts feeds it into both embedding batchSize
  // and qdrant upsertBatchSize.
  { canonical: "EMBEDDING_TUNE_BATCH_SIZE", aliases: ["EMBEDDING_BATCH_SIZE", "CODE_BATCH_SIZE"] },
  { canonical: "EMBEDDING_TUNE_MIN_BATCH_SIZE", aliases: ["MIN_BATCH_SIZE"] },
  { canonical: "EMBEDDING_TUNE_BATCH_TIMEOUT_MS", aliases: ["BATCH_FORMATION_TIMEOUT_MS"] },
  { canonical: "EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE", aliases: ["EMBEDDING_MAX_REQUESTS_PER_MINUTE"] },
  { canonical: "EMBEDDING_TUNE_RETRY_ATTEMPTS", aliases: ["EMBEDDING_RETRY_ATTEMPTS"] },
  { canonical: "EMBEDDING_TUNE_RETRY_DELAY_MS", aliases: ["EMBEDDING_RETRY_DELAY"] },
  { canonical: "EMBEDDING_TUNE_HEALTH_CHECK_RETRY_ATTEMPTS", aliases: ["EMBEDDING_HEALTH_CHECK_RETRY_ATTEMPTS"] },
  { canonical: "EMBEDDING_TUNE_HEALTH_CHECK_RETRY_DELAY_MS", aliases: ["EMBEDDING_HEALTH_CHECK_RETRY_DELAY_MS"] },
  { canonical: "EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS", aliases: ["EMBEDDING_UNAVAILABLE_RETRY_MAX_WAIT_MS"] },
  {
    canonical: "EMBEDDING_TUNE_UNAVAILABLE_RETRY_BASE_DELAY_MS",
    aliases: ["EMBEDDING_UNAVAILABLE_RETRY_BASE_DELAY_MS"],
  },
  // qdrantTune (parse.ts `qdrantTune` section)
  { canonical: "QDRANT_TUNE_UPSERT_BATCH_SIZE", aliases: ["QDRANT_UPSERT_BATCH_SIZE", "CODE_BATCH_SIZE"] },
  { canonical: "QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS", aliases: ["QDRANT_FLUSH_INTERVAL_MS"] },
  { canonical: "QDRANT_TUNE_UPSERT_ORDERING", aliases: ["QDRANT_BATCH_ORDERING"] },
  { canonical: "QDRANT_TUNE_DELETE_BATCH_SIZE", aliases: ["QDRANT_DELETE_BATCH_SIZE", "DELETE_BATCH_SIZE"] },
  { canonical: "QDRANT_TUNE_DELETE_CONCURRENCY", aliases: ["QDRANT_DELETE_CONCURRENCY", "DELETE_CONCURRENCY"] },
  { canonical: "QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS", aliases: ["DELETE_FLUSH_TIMEOUT_MS"] },
  { canonical: "QDRANT_QUANTIZATION_SCALAR", aliases: [] },
  { canonical: "QDRANT_TURBO_QUANT", aliases: [] },
  { canonical: "QDRANT_MAX_RESIDENT_MEMORY_PERCENT", aliases: [] },
  { canonical: "QDRANT_SEARCH_MAX_BATCHSIZE", aliases: [] },
  { canonical: "QDRANT_LOW_MEMORY", aliases: [] },
];

/**
 * Flat allowlist of every recognized spelling (canonical + aliases).
 * Kept for consumers that only need membership checks.
 */
export const TUNING_ENV_ALLOWLIST: readonly string[] = [
  ...new Set(TUNING_ENV_GROUPS.flatMap((g) => [g.canonical, ...g.aliases])),
];

/**
 * Canonical keys whose code default is runtime-ADAPTIVE, not a static value:
 * GPU-calibrated embedding batch size, per-language chunk sizing
 * (indexing-ops), and embedded-mode delete tuning (factory). The snapshot
 * materializes these only when the user explicitly set them (the config
 * layer marks exactly these four via its `userSet*` flags) — pinning an
 * adaptive value would freeze behavior the default recomputes per run.
 */
export const ADAPTIVE_DEFAULT_TUNING_KEYS: ReadonlySet<string> = new Set([
  "EMBEDDING_TUNE_BATCH_SIZE",
  "INGEST_CHUNK_SIZE",
  "QDRANT_TUNE_DELETE_BATCH_SIZE",
  "QDRANT_TUNE_DELETE_CONCURRENCY",
]);
