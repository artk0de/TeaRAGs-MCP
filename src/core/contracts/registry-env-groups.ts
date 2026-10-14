/**
 * The registry env vocabulary — every alias family an indexing run persists to
 * and replays from the project registry, as ONE table (tea-rags-mcp-9vpnz).
 *
 * Three files have to agree on it, and this table is where they meet:
 * - `bootstrap/config/parse.ts` reads each family (canonical name first, then
 *   the deprecated spellings, in that order);
 * - `bootstrap/config/env-snapshot.ts` emits each family's CANONICAL key at its
 *   parsed effective value — typed by {@link RegistryEnvCanonicalKey}, so a key
 *   no family declares does not compile;
 * - the registry domain (`domains/maintenance/registry/env-groups.ts`) derives
 *   its group lookups, replay and seeding from it.
 *
 * It lives in contracts because the stable config component and the registry
 * domain both depend on it, and config may not reach a domain (bd
 * tea-rags-mcp-umixb). Pure data over contract types: the contracts exception.
 */

import type { RegistryEnvGroup } from "./types/registry.js";

const REGISTRY_ENV_GROUP_TABLE = [
  // vcs (parse.ts `vcs` section). Which adapter walks the history is an
  // implementation swap — the commits it reports are the same commits.
  { canonical: "GIT_ADAPTER", aliases: [], consequence: "runtime" },
  // embedding identity (dedicated CollectionEntry fields — see module doc).
  // Model / provider / dimensions decide the VECTORS, so they move the chunk
  // set; the endpoints only decide who computes them.
  { canonical: "EMBEDDING_MODEL", aliases: [], consequence: "chunk-set" },
  // Quantization swaps the effective model (quantized tag) — the vectors
  // change with it, so it is a chunk-set consequence like the model itself.
  { canonical: "OLLAMA_QUANTIZATION", aliases: ["EMBEDDING_OLLAMA_QUANTIZATION"], consequence: "chunk-set" },
  { canonical: "EMBEDDING_BASE_URL", aliases: ["OLLAMA_URL"], consequence: "runtime" },
  { canonical: "EMBEDDING_FALLBACK_URL", aliases: ["OLLAMA_FALLBACK_URL"], consequence: "runtime" },
  { canonical: "QDRANT_URL", aliases: [], consequence: "runtime" },
  { canonical: "CODEGRAPH_ENABLED", aliases: [], consequence: "enrichment:codegraph" },
  // embedding operating modes (parse.ts `embedding` section, non-secret)
  { canonical: "EMBEDDING_PROVIDER", aliases: [], consequence: "chunk-set" },
  { canonical: "EMBEDDING_DIMENSIONS", aliases: [], consequence: "chunk-set" },
  { canonical: "EMBEDDING_DEVICE", aliases: [], consequence: "runtime" },
  { canonical: "OLLAMA_LEGACY_API", aliases: [], consequence: "runtime" },
  { canonical: "OLLAMA_NUM_GPU", aliases: [], consequence: "runtime" },
  // Whether a missing model is fetched before embedding — never which vectors.
  { canonical: "EMBEDDING_AUTO_PULL", aliases: [], consequence: "runtime" },
  // trajectoryGit (parse.ts `trajectoryGit` section). The windows and the
  // session model change the COMPUTED signals; the timeouts, pool sizes and
  // concurrency only change how long computing them takes.
  { canonical: "TRAJECTORY_GIT_ENABLED", aliases: ["CODE_ENABLE_GIT_METADATA"], consequence: "enrichment:git" },
  {
    canonical: "TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS",
    aliases: ["GIT_LOG_MAX_AGE_MONTHS"],
    consequence: "enrichment:git",
  },
  { canonical: "TRAJECTORY_GIT_LOG_TIMEOUT_MS", aliases: ["GIT_LOG_TIMEOUT_MS"], consequence: "runtime" },
  { canonical: "TRAJECTORY_GIT_CHUNK_CONCURRENCY", aliases: ["GIT_CHUNK_CONCURRENCY"], consequence: "runtime" },
  { canonical: "TRAJECTORY_GIT_BLAME_POOL_SIZE", aliases: [], consequence: "runtime" },
  {
    canonical: "TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS",
    aliases: ["GIT_CHUNK_MAX_AGE_MONTHS"],
    consequence: "enrichment:git",
  },
  { canonical: "TRAJECTORY_GIT_CHUNK_TIMEOUT_MS", aliases: ["GIT_CHUNK_TIMEOUT_MS"], consequence: "runtime" },
  {
    canonical: "TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES",
    aliases: ["GIT_CHUNK_MAX_FILE_LINES"],
    consequence: "enrichment:git",
  },
  { canonical: "TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS", aliases: [], consequence: "enrichment:git" },
  { canonical: "TRAJECTORY_GIT_SESSION_GAP_MINUTES", aliases: [], consequence: "enrichment:git" },
  // The instant every window and age is measured from — a flip moves them all.
  { canonical: "TRAJECTORY_GIT_ANCHOR", aliases: [], consequence: "enrichment:git" },
  // ingest feature modes (parse.ts `ingest` section). AST on/off and the test
  // path set both decide what a chunk IS.
  { canonical: "INGEST_ENABLE_AST", aliases: ["CODE_ENABLE_AST"], consequence: "chunk-set" },
  { canonical: "INGEST_ENABLE_HYBRID", aliases: ["CODE_ENABLE_HYBRID"], consequence: "chunk-set" },
  { canonical: "CODE_TEST_PATHS", aliases: [], consequence: "chunk-set" },
  // ingest.tune (parse.ts `ingestTune` section)
  {
    canonical: "INGEST_PIPELINE_CONCURRENCY",
    aliases: ["EMBEDDING_TUNE_CONCURRENCY", "EMBEDDING_CONCURRENCY"],
    consequence: "runtime",
  },
  { canonical: "INGEST_TUNE_CHUNKER_POOL_SIZE", aliases: ["CHUNKER_POOL_SIZE"], consequence: "runtime" },
  { canonical: "INGEST_TUNE_FILE_CONCURRENCY", aliases: ["FILE_PROCESSING_CONCURRENCY"], consequence: "runtime" },
  { canonical: "INGEST_TUNE_IO_CONCURRENCY", aliases: ["MAX_IO_CONCURRENCY"], consequence: "runtime" },
  { canonical: "INGEST_TUNE_ENRICHMENT_POOL_SIZE", aliases: ["ENRICHMENT_POOL_SIZE"], consequence: "runtime" },
  { canonical: "INGEST_TUNE_ENRICHMENT_FILES_PER_THREAD", aliases: [], consequence: "runtime" },
  // ingest chunking (parse.ts `ingest` section) — boundaries, hence point ids
  { canonical: "INGEST_CHUNK_SIZE", aliases: ["CODE_CHUNK_SIZE"], consequence: "chunk-set" },
  { canonical: "INGEST_CHUNK_OVERLAP", aliases: ["CODE_CHUNK_OVERLAP"], consequence: "chunk-set" },
  // codegraph (parse.ts `codegraph` section; the enabled flag is identity
  // above). What the walk SKIPS and how an ambiguous target resolves change
  // the edges; the DuckDB knobs are storage limits.
  { canonical: "CODEGRAPH_DB_PATH", aliases: [], consequence: "runtime" },
  { canonical: "CODEGRAPH_DB_MEMORY_LIMIT", aliases: [], consequence: "runtime" },
  { canonical: "CODEGRAPH_DB_MEMORY_LIMIT_MAX", aliases: [], consequence: "runtime" },
  { canonical: "CODEGRAPH_DB_THREADS", aliases: [], consequence: "runtime" },
  { canonical: "CODEGRAPH_CUSTOM_EXCLUDE", aliases: [], consequence: "enrichment:codegraph" },
  { canonical: "CODEGRAPH_AMBIGUOUS_RESOLVE_MODE", aliases: [], consequence: "enrichment:codegraph" },
  // embedding.tune (parse.ts `embeddingTune` section). CODE_BATCH_SIZE is a
  // member of TWO groups — parse.ts feeds it into both embedding batchSize
  // and qdrant upsertBatchSize.
  {
    canonical: "EMBEDDING_TUNE_BATCH_SIZE",
    aliases: ["EMBEDDING_BATCH_SIZE", "CODE_BATCH_SIZE"],
    consequence: "runtime",
  },
  { canonical: "EMBEDDING_TUNE_MIN_BATCH_SIZE", aliases: ["MIN_BATCH_SIZE"], consequence: "runtime" },
  { canonical: "EMBEDDING_TUNE_BATCH_TIMEOUT_MS", aliases: ["BATCH_FORMATION_TIMEOUT_MS"], consequence: "runtime" },
  {
    canonical: "EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE",
    aliases: ["EMBEDDING_MAX_REQUESTS_PER_MINUTE"],
    consequence: "runtime",
  },
  { canonical: "EMBEDDING_TUNE_RETRY_ATTEMPTS", aliases: ["EMBEDDING_RETRY_ATTEMPTS"], consequence: "runtime" },
  { canonical: "EMBEDDING_TUNE_RETRY_DELAY_MS", aliases: ["EMBEDDING_RETRY_DELAY"], consequence: "runtime" },
  {
    canonical: "EMBEDDING_TUNE_HEALTH_CHECK_RETRY_ATTEMPTS",
    aliases: ["EMBEDDING_HEALTH_CHECK_RETRY_ATTEMPTS"],
    consequence: "runtime",
  },
  {
    canonical: "EMBEDDING_TUNE_HEALTH_CHECK_RETRY_DELAY_MS",
    aliases: ["EMBEDDING_HEALTH_CHECK_RETRY_DELAY_MS"],
    consequence: "runtime",
  },
  {
    canonical: "EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS",
    aliases: ["EMBEDDING_UNAVAILABLE_RETRY_MAX_WAIT_MS"],
    consequence: "runtime",
  },
  {
    canonical: "EMBEDDING_TUNE_UNAVAILABLE_RETRY_BASE_DELAY_MS",
    aliases: ["EMBEDDING_UNAVAILABLE_RETRY_BASE_DELAY_MS"],
    consequence: "runtime",
  },
  { canonical: "EMBEDDING_TUNE_FAILOVER_CONSECUTIVE_FAILURES", aliases: [], consequence: "runtime" },
  // Pins the static batch size / concurrency instead of the throughput tuner —
  // how fast vectors are computed, never which vectors.
  { canonical: "EMBEDDING_TUNE_STATIC", aliases: [], consequence: "runtime" },
  // qdrantTune (parse.ts `qdrantTune` section) — write path and storage
  // settings only; quantization is applied in place on the live collection.
  {
    canonical: "QDRANT_TUNE_UPSERT_BATCH_SIZE",
    aliases: ["QDRANT_UPSERT_BATCH_SIZE", "CODE_BATCH_SIZE"],
    consequence: "runtime",
  },
  {
    canonical: "QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS",
    aliases: ["QDRANT_FLUSH_INTERVAL_MS"],
    consequence: "runtime",
  },
  { canonical: "QDRANT_TUNE_UPSERT_ORDERING", aliases: ["QDRANT_BATCH_ORDERING"], consequence: "runtime" },
  {
    canonical: "QDRANT_TUNE_DELETE_BATCH_SIZE",
    aliases: ["QDRANT_DELETE_BATCH_SIZE", "DELETE_BATCH_SIZE"],
    consequence: "runtime",
  },
  {
    canonical: "QDRANT_TUNE_DELETE_CONCURRENCY",
    aliases: ["QDRANT_DELETE_CONCURRENCY", "DELETE_CONCURRENCY"],
    consequence: "runtime",
  },
  { canonical: "QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS", aliases: ["DELETE_FLUSH_TIMEOUT_MS"], consequence: "runtime" },
  { canonical: "QDRANT_TUNE_WRITE_BARRIER_BUDGET_MS", aliases: [], consequence: "runtime" },
  { canonical: "QDRANT_QUANTIZATION_SCALAR", aliases: [], consequence: "runtime" },
  { canonical: "QDRANT_TURBO_QUANT", aliases: [], consequence: "runtime" },
  { canonical: "QDRANT_MAX_RESIDENT_MEMORY_PERCENT", aliases: [], consequence: "runtime" },
  { canonical: "QDRANT_SEARCH_MAX_BATCHSIZE", aliases: [], consequence: "runtime" },
  { canonical: "QDRANT_LOW_MEMORY", aliases: [], consequence: "runtime" },
] as const satisfies readonly RegistryEnvGroup[];

/** A canonical registry env key — the only spelling a registry stamp stores. */
export type RegistryEnvCanonicalKey = (typeof REGISTRY_ENV_GROUP_TABLE)[number]["canonical"];

export const REGISTRY_ENV_GROUPS: readonly RegistryEnvGroup[] = REGISTRY_ENV_GROUP_TABLE;
