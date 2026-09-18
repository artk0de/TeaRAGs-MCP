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
 * The two functions at the bottom of this file are the READ-side twins: the
 * same snapshot vocabulary, but for runs that have not happened.
 * `buildEffectiveIndexEnvSnapshot` is what a stamp resolves to under the
 * current process env; `buildRunningIndexEnvSnapshot` is what THIS process
 * resolved on its own, with no replay. The env drift axis diffs the stamp
 * against the first, and the two enable flags against the second.
 */

import type { EmbeddingConfig, QdrantTuneConfig, TrajectoryGitConfig, VcsConfig } from "../../core/contracts/index.js";
// Deep import, not the registry barrel: `env-replay.js` depends on nothing but
// the group table, while the barrel reaches the qdrant-daemon and vcs adapters
// through `env-resolution.js`.
import {
  outerEnvForRegistryStamp,
  replayRegistryEnv,
  type AmbientEnvRole,
} from "../../core/domains/maintenance/registry/env-replay.js";
import { isDebug } from "../../core/infra/runtime.js";
import { parseAppConfigZod } from "./parse.js";
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

export function buildRegistryEnvSnapshot(config: RegistryEnvSnapshotSource): Record<string, string> {
  const { vcs, trajectoryGit, ingest, embedding, codegraph, qdrantTune, flags } = config;
  const snapshot: Record<string, string> = {};
  const put = (key: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined) snapshot[key] = String(value);
  };
  const putList = (key: string, value: readonly string[] | undefined): void => {
    if (value !== undefined) snapshot[key] = value.join(",");
  };

  put("GIT_ADAPTER", vcs.adapter);

  put("EMBEDDING_PROVIDER", embedding.provider);
  put("EMBEDDING_DIMENSIONS", embedding.dimensions);
  put("EMBEDDING_DEVICE", embedding.device);
  put("OLLAMA_LEGACY_API", embedding.ollamaLegacyApi);
  put("OLLAMA_NUM_GPU", embedding.ollamaNumGpu);

  put("TRAJECTORY_GIT_ENABLED", trajectoryGit.enabled);
  put("TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS", trajectoryGit.logMaxAgeMonths);
  put("TRAJECTORY_GIT_LOG_TIMEOUT_MS", trajectoryGit.logTimeoutMs);
  put("TRAJECTORY_GIT_CHUNK_CONCURRENCY", trajectoryGit.chunkConcurrency);
  put("TRAJECTORY_GIT_BLAME_POOL_SIZE", trajectoryGit.blamePoolSize);
  put("TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS", trajectoryGit.chunkMaxAgeMonths);
  put("TRAJECTORY_GIT_CHUNK_TIMEOUT_MS", trajectoryGit.chunkTimeoutMs);
  put("TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES", trajectoryGit.chunkMaxFileLines);
  put("TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS", trajectoryGit.squashAwareSessions);
  put("TRAJECTORY_GIT_SESSION_GAP_MINUTES", trajectoryGit.sessionGapMinutes);

  put("INGEST_ENABLE_AST", ingest.enableAST);
  put("INGEST_ENABLE_HYBRID", ingest.enableHybrid);
  putList("CODE_TEST_PATHS", ingest.testPaths);
  put("INGEST_PIPELINE_CONCURRENCY", ingest.tune.pipelineConcurrency);
  put("INGEST_TUNE_CHUNKER_POOL_SIZE", ingest.tune.chunkerPoolSize);
  put("INGEST_TUNE_FILE_CONCURRENCY", ingest.tune.fileConcurrency);
  put("INGEST_TUNE_IO_CONCURRENCY", ingest.tune.ioConcurrency);
  put("INGEST_TUNE_ENRICHMENT_POOL_SIZE", ingest.tune.enrichmentPoolSize);
  put("INGEST_TUNE_ENRICHMENT_FILES_PER_THREAD", ingest.tune.enrichmentFilesPerThread);
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
export function buildRunningIndexEnvSnapshot(config: RegistryEnvSnapshotSource): Readonly<Record<string, string>> {
  return {
    ...buildRegistryEnvSnapshot(config),
    CODEGRAPH_ENABLED: String(config.codegraph.enabled),
    ...(config.embedding.model ? { EMBEDDING_MODEL: config.embedding.model } : {}),
  };
}

/**
 * The canonical env snapshot the NEXT index run on `collectionName` would
 * produce, given the snapshot its last run stamped (`EnvDriftMonitor`, spec
 * decision 6).
 *
 * The same resolution `ProjectIngestFactory#forPath` performs before it builds
 * an ingest facade — outer env > stored registry env > code default, where a
 * `server` role narrows the outer env to what `outerEnvForRegistryStamp` lets
 * it override — expressed as a snapshot so it can be diffed against the stamp
 * key for key. It lives
 * here rather than in the monitor because `core/` must not import `bootstrap/`,
 * and because this is where the snapshot vocabulary already lives. Replay
 * writes onto a COPY of `ambient`; `process.env` is never mutated.
 *
 * An unparseable result is no claim, not a throw. A stamp can carry a value the
 * current build no longer accepts (a retired enum member), and this runs on the
 * read path behind a search response, where a diagnostic must never fail the
 * query. It is not silent, though: a swallowed parse disables the whole env
 * axis for that collection, which is indistinguishable from "nothing drifted",
 * so the reason goes to the debug log under the collection's own name. The
 * stamp itself is not tolerated anywhere that matters — the next index run
 * parses the same env and refuses to start.
 */
export function buildEffectiveIndexEnvSnapshot(
  stored: Readonly<Record<string, string>>,
  collectionName: string,
  ambient: NodeJS.ProcessEnv = process.env,
  /**
   * Where `ambient` came from — the same role `ProjectIngestFactory` resolves a
   * real run with, or the axis reports what no run would do. A server's spawn
   * env yields every index-shaping group the stamp pins (tea-rags-mcp-o0qsw).
   */
  role: AmbientEnvRole = "invocation",
): Readonly<Record<string, string>> {
  try {
    const env: NodeJS.ProcessEnv = { ...outerEnvForRegistryStamp(stored, ambient, role) };
    replayRegistryEnv(stored, env);
    return buildRunningIndexEnvSnapshot(parseAppConfigZod(env));
  } catch (error) {
    if (isDebug()) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[Drift] env axis skipped for ${collectionName}: its env stamp does not parse here — ${reason}`);
    }
    return {};
  }
}
