/**
 * Registry env vocabulary — the FULL env surface of an indexing run, persisted
 * to and replayed from the project registry (tea-rags-mcp-9vpnz).
 *
 * ONE general rule, ONE mechanism, no "tuning" category:
 * `outer env > project registry env > code default`, applied PER ALIAS GROUP.
 * Each group mirrors one alias family read by `bootstrap/config/parse.ts`
 * (canonical name + deprecated spellings, resolved by `envWithFallback` in
 * that order). The snapshot builder (`bootstrap/config/env-snapshot.ts`)
 * emits one CANONICAL key per group at its parsed effective value — code
 * defaults materialized — and replay (`cli/registry-env-replay.ts`) skips a
 * whole group when ANY spelling is set in the ambient env, so an externally
 * passed deprecated alias still overrides the stored canonical key.
 *
 * The ONLY env kinds outside this mechanism:
 * - secrets (OPENAI/COHERE/VOYAGE/QDRANT API keys) — never persisted;
 * - server/process knobs (DEBUG, SERVER_TRANSPORT, ports, timeouts) —
 *   properties of the process, not of a project.
 *
 * Identity keys (DEDICATED_FIELD_ENV_KEYS) are persisted in dedicated
 * CollectionEntry fields rather than the `env` map — they carry richer
 * semantics than a verbatim string (QDRANT_URL resolves the embedded-daemon
 * sentinel, EMBEDDING_MODEL feeds the model guard) — but they REPLAY through
 * the same group-aware path: `resolveRegistryEnv` composes them with the
 * stored `env` map into one replay set, so the general precedence rule holds
 * uniformly (an external OLLAMA_URL beats the registry EMBEDDING_BASE_URL).
 */

/**
 * What a change to one env group invalidates in an EXISTING index.
 *
 * The classes are the drift remedy lattice read backwards: `chunk-set` moves
 * chunk point ids (nothing short of `--force` is coherent), each
 * `enrichment:<trajectory>` rewrites that trajectory's payload in place
 * (`--force-enrichments <trajectory>`), and `runtime` describes only HOW the
 * run executes — endpoints, pool sizes, batch sizes, timeouts, DuckDB limits.
 * Changing a `runtime` value produces byte-identical indexed data, so it is
 * never drift.
 */
export type EnvConsequence = "chunk-set" | "enrichment:git" | "enrichment:codegraph" | "runtime";

/** One alias family: the canonical env name plus its deprecated spellings. */
export interface RegistryEnvGroup {
  canonical: string;
  aliases: readonly string[];
  /** What a change to this value invalidates in an existing index. */
  consequence: EnvConsequence;
}

export const REGISTRY_ENV_GROUPS: readonly RegistryEnvGroup[] = [
  // vcs (parse.ts `vcs` section). Which adapter walks the history is an
  // implementation swap — the commits it reports are the same commits.
  { canonical: "GIT_ADAPTER", aliases: [], consequence: "runtime" },
  // embedding identity (dedicated CollectionEntry fields — see module doc).
  // Model / provider / dimensions decide the VECTORS, so they move the chunk
  // set; the endpoints only decide who computes them.
  { canonical: "EMBEDDING_MODEL", aliases: [], consequence: "chunk-set" },
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
  { canonical: "QDRANT_QUANTIZATION_SCALAR", aliases: [], consequence: "runtime" },
  { canonical: "QDRANT_TURBO_QUANT", aliases: [], consequence: "runtime" },
  { canonical: "QDRANT_MAX_RESIDENT_MEMORY_PERCENT", aliases: [], consequence: "runtime" },
  { canonical: "QDRANT_SEARCH_MAX_BATCHSIZE", aliases: [], consequence: "runtime" },
  { canonical: "QDRANT_LOW_MEMORY", aliases: [], consequence: "runtime" },
];

/**
 * Flat allowlist of every recognized spelling (canonical + aliases).
 * Kept for consumers that only need membership checks.
 */
export const REGISTRY_ENV_ALLOWLIST: readonly string[] = [
  ...new Set(REGISTRY_ENV_GROUPS.flatMap((g) => [g.canonical, ...g.aliases])),
];

/**
 * Both group lookups derived from the ONE table above, so no consumer has to
 * restate the alias families. A spelling shared by two groups (CODE_BATCH_SIZE
 * sits in both the embedding-batch and the qdrant-upsert family, because
 * parse.ts feeds it into both) belongs to BOTH, and every consumer treats it
 * as affecting both — conservatively, in whichever direction is safe for it.
 */
const GROUPS_BY_SPELLING: ReadonlyMap<string, readonly RegistryEnvGroup[]> = (() => {
  const byKey = new Map<string, RegistryEnvGroup[]>();
  for (const group of REGISTRY_ENV_GROUPS) {
    for (const spelling of [group.canonical, ...group.aliases]) {
      const groups = byKey.get(spelling) ?? [];
      groups.push(group);
      byKey.set(spelling, groups);
    }
  }
  return byKey;
})();

/**
 * Every spelling that can shadow `key`: the UNION of all alias families it
 * belongs to. Replay uses it to decide whether an externally-set spelling
 * already covers a stored key; the tune → registry write uses it to evict the
 * siblings of a key it just measured.
 *
 * A spelling outside every known group (written by a newer tea-rags) is its own
 * sole member, so callers degrade to same-key behavior instead of failing.
 */
export function registryEnvGroupMembers(key: string): readonly string[] {
  const groups = GROUPS_BY_SPELLING.get(key);
  if (!groups) return [key];
  return [...new Set(groups.flatMap((g) => [g.canonical, ...g.aliases]))];
}

/**
 * The CANONICAL key(s) `key` resolves to — the spelling the registry stores
 * (see `bootstrap/config/env-snapshot.ts`, which emits one canonical key per
 * group). A canonical key resolves to itself, an alias to its group's
 * canonical, a two-group alias to both, and an unknown spelling to itself.
 */
export function canonicalRegistryEnvKeys(key: string): readonly string[] {
  const groups = GROUPS_BY_SPELLING.get(key);
  if (!groups) return [key];
  return [...new Set(groups.map((g) => g.canonical))];
}

/**
 * Identity keys persisted in DEDICATED CollectionEntry fields (embeddingModel,
 * embeddingBaseUrl, embeddingFallbackUrl, qdrantUrl, codegraphEnabled) rather
 * than the generic `env` map — richer semantics than a verbatim string
 * (embedded-daemon sentinel resolution, model guard). The snapshot builder
 * skips them; `resolveRegistryEnv` composes them back into the ONE replay set.
 */
export const DEDICATED_FIELD_ENV_KEYS: ReadonlySet<string> = new Set([
  "EMBEDDING_MODEL",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_FALLBACK_URL",
  "QDRANT_URL",
  "CODEGRAPH_ENABLED",
]);

/**
 * Canonical keys whose code default is runtime-ADAPTIVE, not a static value:
 * GPU-calibrated embedding batch size, per-language chunk sizing
 * (indexing-ops), and embedded-mode delete tuning (factory). The snapshot
 * materializes these only when the user explicitly set them (the config
 * layer marks exactly these four via its `userSet*` flags) — pinning an
 * adaptive value would freeze behavior the default recomputes per run.
 */
export const ADAPTIVE_DEFAULT_ENV_KEYS: ReadonlySet<string> = new Set([
  "EMBEDDING_TUNE_BATCH_SIZE",
  "INGEST_CHUNK_SIZE",
  "QDRANT_TUNE_DELETE_BATCH_SIZE",
  "QDRANT_TUNE_DELETE_CONCURRENCY",
]);
