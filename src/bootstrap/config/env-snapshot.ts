/**
 * buildRegistryEnvSnapshot — the full effective env set of this indexing run,
 * keyed by CANONICAL env names, for persistence into `CollectionEntry.env`
 * (tea-rags-mcp-9vpnz).
 *
 * Built from the PARSED zod config rather than process.env so code defaults
 * (including provider-conditional ones) materialize at their true effective
 * values — the registry snapshot is complete and self-sufficient: a bare-env
 * `tea-rags index-codebase` reproduces the last run's configuration even if
 * a later tea-rags version changes a code default.
 *
 * Deliberate gaps (see env-groups.ts module doc for the full contract):
 * - DEDICATED_FIELD_ENV_KEYS (EMBEDDING_MODEL / *_BASE_URL / *_FALLBACK_URL /
 *   QDRANT_URL / CODEGRAPH_ENABLED) live in dedicated CollectionEntry fields;
 *   `resolveRegistryEnv` composes them back into the one replay set.
 * - ADAPTIVE_DEFAULT_ENV_KEYS (GPU-calibrated batch size, per-language chunk
 *   sizing, embedded-mode delete tuning) are included only when the user
 *   explicitly set them — the config layer marks exactly those four via its
 *   `userSet*` flags. Pinning an adaptive value would freeze behavior the
 *   default recomputes per run (e.g. one chunk size for all languages).
 * - Optional knobs with no code default are skipped while unset — there is
 *   no value to pin.
 * - Secrets and server/process knobs are outside the mechanism entirely.
 *
 * Injected into the ingest pipeline via DI (like `teaRagsVersion`) and
 * written by `recordRegistryEntry` on every successful index.
 *
 * `buildRunningIndexEnvSnapshot` at the bottom of this file is a READ-side
 * twin: what THIS process resolved on its own, with no replay — the side the
 * env drift axis compares the two enable flags against. Its other twin,
 * `buildEffectiveIndexEnvSnapshot` (what a stamp resolves to under the current
 * process env), lives in the composition root because it replays the registry
 * env (bd tea-rags-mcp-umixb).
 *
 * Config passes a few knobs through raw — `undefined` when unset — and their
 * owning domain applies the default. The snapshot records effective values, so
 * those defaults are INJECTED (`DomainEnvCodeDefaults`, built by
 * `resolveDomainEnvCodeDefaults` in the core composition root): this stable
 * component must not read a domain (bd tea-rags-mcp-umixb).
 */

import type {
  DomainEnvCodeDefaults,
  EmbeddingConfig,
  QdrantTuneConfig,
  TrajectoryGitConfig,
  VcsConfig,
} from "../../core/contracts/index.js";
import type { RegistryEnvCanonicalKey } from "../../core/contracts/registry-env-groups.js";
import type { CodegraphConfig, IngestConfig } from "./schemas.js";

export interface RegistryEnvSnapshotSource {
  vcs: VcsConfig;
  trajectoryGit: TrajectoryGitConfig;
  ingest: IngestConfig;
  embedding: EmbeddingConfig;
  codegraph: CodegraphConfig;
  qdrantTune: QdrantTuneConfig;
  flags: {
    userSetBatchSize: boolean;
    userSetChunkSize: boolean;
    userSetDeleteBatchSize: boolean;
    userSetDeleteConcurrency: boolean;
  };
}

export function buildRegistryEnvSnapshot(
  config: RegistryEnvSnapshotSource,
  domainDefaults: DomainEnvCodeDefaults,
): Record<string, string> {
  const { vcs, trajectoryGit, ingest, embedding, codegraph, qdrantTune, flags } = config;
  const snapshot: Record<string, string> = {};
  // Typed by the registry vocabulary: a key no alias family declares does not
  // compile, so the snapshot and the families cannot drift apart silently.
  const put = (key: RegistryEnvCanonicalKey, value: string | number | boolean | undefined): void => {
    if (value !== undefined) snapshot[key] = String(value);
  };
  const putList = (key: RegistryEnvCanonicalKey, value: readonly string[] | undefined): void => {
    if (value !== undefined) snapshot[key] = value.join(",");
  };

  put("GIT_ADAPTER", vcs.adapter);

  put("EMBEDDING_PROVIDER", embedding.provider);
  put("EMBEDDING_DIMENSIONS", embedding.dimensions);
  put("EMBEDDING_DEVICE", embedding.device);
  put("OLLAMA_LEGACY_API", embedding.ollamaLegacyApi);
  put("OLLAMA_NUM_GPU", embedding.ollamaNumGpu);
  put("OLLAMA_QUANTIZATION", embedding.ollamaQuantization);
  put("EMBEDDING_AUTO_PULL", embedding.autoPull);

  put("TRAJECTORY_GIT_ENABLED", trajectoryGit.enabled);
  put("TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS", trajectoryGit.logMaxAgeMonths);
  put("TRAJECTORY_GIT_LOG_TIMEOUT_MS", trajectoryGit.logTimeoutMs);
  put("TRAJECTORY_GIT_CHUNK_CONCURRENCY", trajectoryGit.chunkConcurrency);
  put("TRAJECTORY_GIT_BLAME_POOL_SIZE", trajectoryGit.blamePoolSize ?? domainDefaults.blamePoolSize);
  put("TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS", trajectoryGit.chunkMaxAgeMonths);
  put("TRAJECTORY_GIT_CHUNK_TIMEOUT_MS", trajectoryGit.chunkTimeoutMs);
  put("TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES", trajectoryGit.chunkMaxFileLines);
  put("TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS", trajectoryGit.squashAwareSessions);
  put("TRAJECTORY_GIT_SESSION_GAP_MINUTES", trajectoryGit.sessionGapMinutes);
  put("TRAJECTORY_GIT_ANCHOR", trajectoryGit.anchor);

  put("INGEST_ENABLE_AST", ingest.enableAST);
  put("INGEST_ENABLE_HYBRID", ingest.enableHybrid);
  putList("CODE_TEST_PATHS", ingest.testPaths);
  put("INGEST_PIPELINE_CONCURRENCY", ingest.tune.pipelineConcurrency);
  put("INGEST_TUNE_CHUNKER_POOL_SIZE", ingest.tune.chunkerPoolSize ?? domainDefaults.chunkerPoolSize);
  put("INGEST_TUNE_FILE_CONCURRENCY", ingest.tune.fileConcurrency);
  put("INGEST_TUNE_IO_CONCURRENCY", ingest.tune.ioConcurrency);
  put("INGEST_TUNE_ENRICHMENT_POOL_SIZE", ingest.tune.enrichmentPoolSize);
  put(
    "INGEST_TUNE_ENRICHMENT_FILES_PER_THREAD",
    ingest.tune.enrichmentFilesPerThread ?? domainDefaults.enrichmentFilesPerThread,
  );
  if (flags.userSetChunkSize) put("INGEST_CHUNK_SIZE", ingest.chunkSize);
  put("INGEST_CHUNK_OVERLAP", ingest.chunkOverlap);

  put("CODEGRAPH_DB_PATH", codegraph.dbPath);
  put("CODEGRAPH_DB_MEMORY_LIMIT", codegraph.dbMemoryLimit);
  put("CODEGRAPH_DB_MEMORY_LIMIT_MAX", codegraph.dbMemoryLimitMax);
  put("CODEGRAPH_DB_THREADS", codegraph.dbThreads);
  putList("CODEGRAPH_CUSTOM_EXCLUDE", codegraph.customExcludePatterns);
  put("CODEGRAPH_AMBIGUOUS_RESOLVE_MODE", codegraph.ambiguousResolveMode);

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
  put("EMBEDDING_TUNE_FAILOVER_CONSECUTIVE_FAILURES", embedding.tune.failoverConsecutiveFailures);
  put("EMBEDDING_TUNE_STATIC", embedding.tune.static);

  put("QDRANT_TUNE_UPSERT_BATCH_SIZE", qdrantTune.upsertBatchSize);
  put("QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS", qdrantTune.upsertFlushIntervalMs);
  put("QDRANT_TUNE_UPSERT_ORDERING", qdrantTune.upsertOrdering);
  if (flags.userSetDeleteBatchSize) put("QDRANT_TUNE_DELETE_BATCH_SIZE", qdrantTune.deleteBatchSize);
  if (flags.userSetDeleteConcurrency) put("QDRANT_TUNE_DELETE_CONCURRENCY", qdrantTune.deleteConcurrency);
  put("QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS", qdrantTune.deleteFlushTimeoutMs);
  put("QDRANT_TUNE_WRITE_BARRIER_BUDGET_MS", qdrantTune.writeBarrierBudgetMs);
  put("QDRANT_QUANTIZATION_SCALAR", qdrantTune.quantizationScalar);
  put("QDRANT_TURBO_QUANT", qdrantTune.turboQuant);
  put("QDRANT_MAX_RESIDENT_MEMORY_PERCENT", qdrantTune.maxResidentMemoryPercent);
  put("QDRANT_SEARCH_MAX_BATCHSIZE", qdrantTune.searchMaxBatchsize);
  put("QDRANT_LOW_MEMORY", qdrantTune.lowMemory);

  return snapshot;
}

/**
 * The part of {@link buildRegistryEnvSnapshot} an index run PINS into its
 * registry entry: only the families its env set explicitly
 * (`flags.explicitEnvKeys`), never a value that is merely the code default
 * (bd tea-rags-mcp-h4l6k).
 *
 * Materializing every default (9vpnz) froze each project at the defaults of the
 * release that first indexed it: all 21 live entries carried
 * `TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES=10000`, so the BREAKING default of 5000
 * reached no project. A pin is an operator's decision; a default keeps
 * following the release. "Explicit" includes what the registry replayed into
 * the run's env, so an existing entry keeps every pin it already has — this
 * narrows what NEW pins are taken, it never drops an old one.
 *
 * The full set stays `buildRegistryEnvSnapshot`'s job: the env drift axis
 * compares resolved values, pinned or not.
 */
export function buildPinnedRegistryEnvSnapshot(
  config: RegistryEnvSnapshotSource & { flags: { explicitEnvKeys: readonly string[] } },
  domainDefaults: DomainEnvCodeDefaults,
): Record<string, string> {
  const explicit = new Set(config.flags.explicitEnvKeys);
  // Both sides speak canonical names: the snapshot emits one per group, and the
  // parser records the canonical name it asked for, whichever spelling answered.
  return Object.fromEntries(
    Object.entries(buildRegistryEnvSnapshot(config, domainDefaults)).filter(([key]) => explicit.has(key)),
  );
}

/**
 * What a parsed config resolves the indexing env to, as a snapshot — the
 * registry snapshot plus the two identity keys it deliberately omits.
 *
 * `buildRegistryEnvSnapshot` skips every DEDICATED_FIELD_ENV_KEY, because those
 * live in dedicated `CollectionEntry` fields rather than the `env` map. For
 * PERSISTENCE that is right; for COMPARISON it is not, because it would leave a
 * flipped `CODEGRAPH_ENABLED` — the drift the env axis exists to attribute —
 * missing from both sides of the diff. Only the two keys with a non-runtime
 * consequence are re-attached; the three URL-shaped ones are `runtime` and
 * would be skipped anyway.
 *
 * Called with THIS process's own config (`getZodConfig()`), it is the running
 * composition's resolved env: what the descriptors the reading process declares
 * were actually built from, with no registry replay anywhere in it. That is the
 * side the two enable flags are compared against.
 */
export function buildRunningIndexEnvSnapshot(
  config: RegistryEnvSnapshotSource,
  domainDefaults: DomainEnvCodeDefaults,
): Readonly<Record<string, string>> {
  return {
    ...buildRegistryEnvSnapshot(config, domainDefaults),
    CODEGRAPH_ENABLED: String(config.codegraph.enabled),
    ...(config.embedding.model ? { EMBEDDING_MODEL: config.embedding.model } : {}),
  };
}
