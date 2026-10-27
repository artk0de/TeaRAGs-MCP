import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { DEFAULT_PAYLOAD_WRITE_BARRIER_BUDGET_MS } from "../../core/contracts/constants.js";
import { DEFAULT_MINIFIED_LINE_LENGTH } from "../../core/primitives/paths/index.js";
import {
  booleanFromEnv,
  booleanFromEnvWithDefault,
  floatWithDefault,
  intWithDefault,
  optionalFloat,
  optionalInt,
  optionalPositiveInt,
} from "./utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const coreSchema = z.object({
  debug: booleanFromEnv,
  qdrantUrl: z.string().optional(),
  qdrantApiKey: z.string().optional(),
  transportMode: z.enum(["stdio", "http"]),
  httpPort: intWithDefault(3000),
  requestTimeoutMs: intWithDefault(300000),
  promptsConfigFile: z.string().default(join(__dirname, "../../../prompts.json")),
  /**
   * `MCP_SERVER_INSTRUCTIONS` — what the MCP `initialize` result carries as
   * `instructions`: the always-on core (`core`) or only the pointer line to
   * `tea-rags://guide/core` (`pointer`, for sessions whose plugin hook already
   * injects the full core).
   */
  serverInstructions: z.enum(["core", "pointer"]).default("core"),
  /**
   * `EXPERIMENTAL_LOCATE_ENABLE` — registers the hidden experimental `locate`
   * tool. Off by default; the tool is not part of any plugin guidance.
   */
  experimentalLocateEnable: booleanFromEnv,
});

export const embeddingTuneSchema = z.object({
  batchSize: intWithDefault(1024),
  minBatchSize: optionalInt,
  batchTimeoutMs: intWithDefault(2000),
  maxRequestsPerMinute: optionalPositiveInt,
  retryAttempts: intWithDefault(3),
  retryDelayMs: intWithDefault(1000),
  /**
   * Attempts for the pre-indexing embedding health probe. The probe can be
   * starved of an event-loop tick by a busy synchronous burst and time out
   * even though the server answers; each retry's pause yields the loop so a
   * starved probe succeeds. A genuinely-down provider fails all attempts and
   * aborts with the typed `OllamaUnavailableError`. Default 3.
   */
  healthCheckRetryAttempts: intWithDefault(3),
  /** Pause between health-probe attempts (ms). The pause yields the event loop. Default 250. */
  healthCheckRetryDelayMs: intWithDefault(250),
  /**
   * Bounded wall-clock budget (ms) to keep retrying a connection-level "provider
   * not reachable" failure while a flapping remote host recovers, before the
   * index aborts. Under sustained embedding load a remote Ollama host can
   * crash/restart → briefly unreachable → recover when idle; without this budget
   * the whole (~20 min) index dies on the first flap. Default 240000 (4 min).
   * Set 0 to abort on the first connection failure.
   */
  unavailableRetryMaxWaitMs: intWithDefault(240_000),
  /** Base backoff between connection-recovery attempts (ms); exponential, capped at 30s. Default 2000. */
  unavailableRetryBaseDelayMs: intWithDefault(2000),
  /**
   * Consecutive failed embed calls on the Ollama primary (transport error,
   * timeout, 5xx, malformed response — never a caller-side 4xx) after which
   * the provider fails over to EMBEDDING_FALLBACK_URL, even though the
   * primary still answers its `GET /` health probe. The existing 60s recovery
   * cooldown and background probe decide the way back. Needs a fallback URL;
   * 0 disables. Default 3.
   */
  failoverConsecutiveFailures: intWithDefault(3),
  /**
   * Opt-out of adaptive embedding (bd tea-rags-mcp-7ju66). By default the
   * ingest pipeline's throughput tuner moves the embed batch size inside
   * [EMBEDDING_TUNE_MIN_BATCH_SIZE, EMBEDDING_TUNE_BATCH_SIZE] — down after a
   * batch the server fails on size, toward the measured fastest size otherwise —
   * and then climbs the embed concurrency on measured aggregate chars/s, never
   * inferring it from the endpoint's address. The climb's ceiling is an explicit
   * INGEST_PIPELINE_CONCURRENCY, or IMPLICIT_EMBEDDING_CONCURRENCY_CEILING (8)
   * when it is unset. `true` pins the configured batch size and
   * INGEST_PIPELINE_CONCURRENCY (1 when unset) for the whole run, ignoring any
   * stored optimum.
   */
  static: booleanFromEnv,
});

export const embeddingSchema = z.object({
  provider: z.enum(["ollama", "openai", "cohere", "voyage", "onnx", "llama-server"]).default("ollama"),
  model: z.string().optional(),
  dimensions: optionalPositiveInt,
  device: z.string().optional().default("auto"),
  baseUrl: z.string().optional(),
  fallbackBaseUrl: z.string().optional(),
  ollamaLegacyApi: booleanFromEnv,
  ollamaNumGpu: intWithDefault(999),
  /**
   * Server-side quantization for the Ollama embedding model. The provider
   * provisions a quantized copy over /api/create (`turbo` = the most
   * aggressive gguf level, q4_K_M — the ollama-side analogue of Qdrant's
   * turbo quantization) and embeds against it; a server that cannot quantize
   * warns and keeps the unquantized model. Quantized vectors differ from
   * F16 ones, so the first run after flipping this re-indexes (the embedding
   * model guard enforces it). Defaults to `off` (unquantized) — opt in.
   */
  ollamaQuantization: z.enum(["off", "q8_0", "q5_K_M", "q4_K_M", "turbo"]).default("off"),
  /**
   * EMBEDDING_AUTO_PULL: when the Ollama server answers `/api/show` with 404
   * for the configured model, pull it over `/api/pull` at startup instead of
   * failing every embed with "model not found". Defaults to true; `false`
   * restores the manual `ollama pull` step.
   */
  autoPull: booleanFromEnvWithDefault(true),
  openaiApiKey: z.string().optional(),
  cohereApiKey: z.string().optional(),
  voyageApiKey: z.string().optional(),
  /**
   * EMBEDDING_API_KEY: bearer token for a llama-server started with
   * `--api-key`, sent to every peer and fallback endpoint. Optional — a
   * server bound to the LAN should set one. A secret: never persisted.
   */
  apiKey: z.string().optional(),
  tune: embeddingTuneSchema,
});

export const ingestTuneSchema = z.object({
  /**
   * Embed/upsert worker concurrency and the sync concurrency. Default 1. Unset
   * (`flags.userSetPipelineConcurrency` false), the adaptive embedding tuner
   * may still climb the embed concurrency up to
   * IMPLICIT_EMBEDDING_CONCURRENCY_CEILING; an explicit value — even 1 — is the
   * climb's hard ceiling.
   */
  pipelineConcurrency: intWithDefault(1),
  /**
   * Parse worker count. Workers now run as child processes (ProcessTransport),
   * so concurrent tree-sitter parsing is safe — the native parse runs in an
   * isolated process memory space (yl9tv). Operators override via
   * `INGEST_TUNE_CHUNKER_POOL_SIZE` / `CHUNKER_POOL_SIZE`. Unset stays
   * `undefined`: the ingest pipeline applies its own `defaultChunkerPoolSize`
   * where it builds the pool (bd tea-rags-mcp-umixb).
   */
  chunkerPoolSize: optionalInt,
  fileConcurrency: intWithDefault(50),
  ioConcurrency: intWithDefault(50),
  /**
   * Worker-pool thread count for the enrichment executor. Production runs
   * through `WorkerPoolEnrichmentExecutor` unconditionally — there is no
   * inline/worker toggle. `InlineEnrichmentExecutor` is the **internal test
   * seam** used by integration tests + recovery scenarios that construct
   * `IngestFacade` directly with their own executor in deps.
   *
   * Default 4 — independent of the single-flight `chunkerPoolSize` (enrichment
   * has no shared native-parse hazard). Operators can override via
   * `INGEST_TUNE_ENRICHMENT_POOL_SIZE` or `ENRICHMENT_POOL_SIZE`.
   */
  enrichmentPoolSize: intWithDefault(4),
  /**
   * Files a run must have per extraction thread before the pass-1 fan-out
   * spins that thread up. `enrichmentPoolSize` stays the CEILING; this says how
   * much work has to exist to reach it, so a small project stops paying for
   * isolates it cannot keep busy. Override via
   * `INGEST_TUNE_ENRICHMENT_FILES_PER_THREAD`. Unset stays `undefined`: the
   * enrichment executor applies `defaultEnrichmentFilesPerThread`, which
   * carries the measurement behind the default (bd tea-rags-mcp-umixb).
   */
  enrichmentFilesPerThread: optionalInt,
});

const commaSeparatedList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").map((s) => s.trim()) : undefined));

export const ingestSchema = z.object({
  chunkSize: intWithDefault(2500),
  chunkOverlap: intWithDefault(300),
  enableAST: booleanFromEnvWithDefault(true),
  enableHybrid: booleanFromEnvWithDefault(true),
  testPaths: commaSeparatedList,
  tune: ingestTuneSchema,
});

export const trajectoryGitSchema = z.object({
  enabled: booleanFromEnvWithDefault(true),
  logMaxAgeMonths: floatWithDefault(12),
  logTimeoutMs: intWithDefault(60000),
  // Floored at the default: a sub-default env value is ignored so the env can
  // only RAISE git chunk walk parallelism, never silently halve it (bd f2jsb:
  // a stale env block pinned 5 vs the code default 10 across every CLI run).
  chunkConcurrency: intWithDefault(10),
  // Git-blame CONCURRENCY = size of the FILE-phase blame worker pool. Blame is
  // native `git blame` (async child process); N workers = N concurrent blames.
  // Parallel git blame is not EDR-capped. The chunk-walk pool is decoupled
  // (capped at 4). Env: TRAJECTORY_GIT_BLAME_POOL_SIZE. Unset stays undefined:
  // the git provider applies `defaultBlamePoolSize` (bd tea-rags-mcp-umixb).
  blamePoolSize: optionalInt,
  chunkMaxAgeMonths: floatWithDefault(6),
  chunkTimeoutMs: intWithDefault(120000),
  // Files above it keep git.file.* but get git.chunk.skippedAs "oversized"
  // (bd tea-rags-mcp-2brzq). 5000: tea-rags has 2 code files above it,
  // taxdome 0 (max 4653); the walk cost it saves is ~0.2-0.7 s per file.
  chunkMaxFileLines: intWithDefault(5000),
  squashAwareSessions: booleanFromEnv,
  sessionGapMinutes: intWithDefault(30),
  // The instant every git window and age is measured from (bd
  // tea-rags-mcp-i6tkc): "now" = the wall clock; "head" = the HEAD commit's
  // committer time, for benchmarks over historical snapshots whose windows
  // would otherwise be empty. Env: TRAJECTORY_GIT_ANCHOR.
  anchor: z.enum(["now", "head"]).default("now"),
});

export const vcsSchema = z.object({
  /**
   * Git history access engine (GIT_ADAPTER): "git" = CLI subprocess
   * (default), "es-git" = in-process libgit2 bindings. Unknown values are a
   * config error — the factory has no silent fallback (fail-loud by design).
   */
  adapter: z.enum(["git", "es-git"]).default("git"),
});

/**
 * Residual resolution (`index-codebase --resolve-residual`, `resolve-codegraph-residual`):
 * model verdicts for the call sites the static resolver left ambiguous or dynamic.
 */
export const codegraphResidualSchema = z.object({
  /** Kev base URLs; several are used round-robin. */
  kevUrls: commaSeparatedList,
  /** Minimum verdict probability for a Kev answer to become an edge. */
  kevThreshold: floatWithDefault(0.7),
  /** Concurrent provider requests (one request per enclosing method). */
  concurrency: intWithDefault(16),
  /** Seconds one provider request may run; Kev answers one batch at a time, so a request also waits for the batches ahead of it. */
  requestTimeoutSec: intWithDefault(300),
  /**
   * Questions one provider request may carry. Kev re-encodes the method state
   * per question, so a request costs about questions × (state + candidates);
   * capping it keeps one request to seconds, far under `requestTimeoutSec`.
   */
  maxQuestionsPerRequest: intWithDefault(8),
  /** Candidates one provider request may carry over all its questions — three full 40-class blocks. */
  maxCriteriaPerRequest: intWithDefault(120),
  /** A site with more candidates than this is not asked. */
  menuLimit: intWithDefault(40),
  /** A site with fewer candidates than this is neither asked nor applied; 1 — a one-class menu plus "none" is asked. */
  minMenu: intWithDefault(1),
  /** Minimum probability of a "none of these" verdict for its site to count as external, out of the recall denominator. */
  noneThreshold: floatWithDefault(0.8),
  /** Minimum probability of a tournament block winner for it to enter the next round. */
  tournamentFloor: floatWithDefault(0.5),
  /** Tournament block questions one run may send; a receiver group the rest cannot cover is skipped and counted. */
  tournamentBudget: intWithDefault(5000),
  /** Smallest probability of a class for it to join a polymorphic-interface fan-out of its receiver group. */
  fanoutFloor: floatWithDefault(0.4),
  /** Ask a mid block-1 or full-menu pick once more as `[pick, none]` and never run plain tournament rounds. */
  confirmStage: booleanFromEnvWithDefault(false),
  /** Append receiver-origin lines (assignments, the returning method's head) to each question's state. */
  originContext: booleanFromEnvWithDefault(false),
  /** Apply the stored per-language Kev threshold calibration, asking and storing a new one when it is missing or stale. */
  autoCalibrate: booleanFromEnvWithDefault(true),
  /** Accept threshold for a name-prior block-1 pick and the confirm of one; unset = `kevThreshold`. */
  namePriorAcceptThreshold: optionalFloat,
  /** Verdicts not seen by any run for this many days are dropped. */
  retentionDays: intWithDefault(180),
  /**
   * GPU session broker on the Kev host (e.g. `http://192.168.1.71:8008`). Set:
   * a pass that has questions leases Kev from it and uses the lease's Kev URL;
   * unset: `kevUrls` is asked directly.
   */
  kevSessionUrl: z.string().optional(),
  /** Broker `X-Broker-Token`. A secret: never in the registry snapshot. */
  kevSessionToken: z.string().optional(),
});

/**
 * `codegraph.rustDriver` — the rustc call-site driver (bd s3i8m T8,
 * research/rustc-driver/SPEC.md §8.3). It IS `cargo check`, so build scripts
 * and proc macros run; on by default whenever discovery finds the driver or
 * the pinned toolchain with rustc-dev.
 */
export const codegraphRustDriverSchema = z.object({
  /** `CODEGRAPH_RUST_DRIVER` — `off` (also `0` / `false` / `no`) turns the slot off. */
  enabled: z
    .string()
    .optional()
    .transform((value) => !/^(off|0|false|no)$/i.test(value?.trim() ?? "")),
  /** `CODEGRAPH_RUST_DRIVER_PATH` — explicit driver binary, tried before every other discovery tier. */
  path: z.string().optional(),
  /** `CODEGRAPH_RUST_DRIVER_JOBS` — parallel rustc processes; unset = `max(1, cores / 2)`. */
  jobs: z.coerce.number().int().positive().optional(),
  /** `CODEGRAPH_RUST_DRIVER_TIMEOUT_SEC` — wall budget of one driver run. */
  timeoutSec: intWithDefault(3600),
  /** `CODEGRAPH_RUST_DRIVER_MAX_RSS_MB` — process-tree resident-memory budget of one driver run. */
  maxRssMb: intWithDefault(12_288),
});

export const codegraphSchema = z.object({
  /**
   * Master switch for the codegraph trajectory family. On by default; opt
   * out with `CODEGRAPH_ENABLED=false`. The value an index run used is
   * recorded per project (`CollectionEntry.codegraphEnabled`) and replayed
   * ahead of this default. When off, no graph extraction runs, no codegraph
   * signals are written to payloads, and the graph-query MCP tools
   * (`get_callers`/`get_callees`/`find_cycles`) are not registered.
   */
  enabled: booleanFromEnvWithDefault(true),
  /**
   * Override for the DuckDB graph DB root directory. Per-collection
   * files go in `<rootDir>/codegraph/<collection>.duckdb`. When unset,
   * the bootstrap factory uses the AppConfig data directory as the root.
   * A legacy `.duckdb`-suffixed path is interpreted as the parent dir.
   */
  dbPath: z.string().optional(),
  /**
   * Per-collection DuckDB memory ceiling. Caps the maximum RAM DuckDB
   * will allocate before spilling to `temp_directory`. Default 2GB —
   * large enough for the slice 2 ingest path (streaming pass-1 spill +
   * checkpointed pass-2 resolve), small enough to prevent the default
   * "80% of system RAM" behavior from causing OOM on large repos
   * (e.g. 14.3GB seen on 5574-file ugnest run before this cap).
   * Format: any DuckDB-accepted size string ("2GB", "512MB", "1.5GB").
   */
  dbMemoryLimit: z.string().default("2GB"),
  /**
   * Ceiling the codegraph daemon's adaptive memory governor may raise the
   * DuckDB memory_limit to during a bulk-ingest write burst (live
   * `SET memory_limit` on the daemon's open RW connection). The base
   * `dbMemoryLimit` is restored when the daemon's idle watcher fires, BEFORE
   * the RW lock is released. Default 4GB. Must be >= `dbMemoryLimit` — a
   * smaller value is a config error and is clamped to `dbMemoryLimit`
   * (logged once). Daemon-only: the direct/in-process write path (tests,
   * direct mode) always stays at `dbMemoryLimit`.
   * Format: any DuckDB-accepted size string ("4GB", "512MB", "1.5GB").
   */
  dbMemoryLimitMax: z.string().default("4GB"),
  /**
   * Number of DuckDB worker threads per collection. Default 2 — the
   * codegraph workload is bottlenecked on the writer transaction lock,
   * not parallel scan, so additional threads inflate memory without
   * speeding indexing.
   */
  dbThreads: intWithDefault(2),
  /**
   * Comma-separated `.gitignore`-shaped patterns added on top of the
   * codegraph exclusion filter. Use to skip vendored copies, generated
   * code, or domain-specific paths the user wants out of the graph.
   * Example: `CODEGRAPH_CUSTOM_EXCLUDE="vendor/**,generated/**,*.pb.go"`.
   */
  customExcludePatterns: commaSeparatedList,
  /**
   * How to resolve short-name lookups that match multiple candidates
   * (e.g. `serializer.is_valid()` with `is_valid` defined on N classes).
   *
   *   - `strict` (default): drop the edge unless exactly one candidate
   *     matches. Eliminates false positives like DRF `is_valid()` being
   *     attributed to an unrelated `ConfirmationCode#is_valid`.
   *   - `first`: legacy — pick the first candidate when multiple match.
   *     Higher recall, more noise; use only if a downstream consumer
   *     genuinely needs the previous arbitrary-but-non-null behavior.
   *
   * Wired into every `CallResolver` at composition time; cannot be
   * changed per-call.
   */
  ambiguousResolveMode: z.enum(["strict", "first"]).default("strict"),
  /** Model-assisted resolution of residual call sites. */
  residual: codegraphResidualSchema.prefault({}),
  rustDriver: codegraphRustDriverSchema.prefault({}),
});

export const qdrantTuneSchema = z.object({
  upsertBatchSize: intWithDefault(100),
  upsertFlushIntervalMs: intWithDefault(500),
  upsertOrdering: z.enum(["weak", "medium", "strong"]).default("weak"),
  deleteBatchSize: intWithDefault(500),
  deleteConcurrency: intWithDefault(8),
  deleteFlushTimeoutMs: intWithDefault(1000),
  /**
   * Total time (ms) enrichment completion waits for Qdrant to apply its queued
   * payload writes before deciding the terminal markers. Qdrant answers one
   * waited request after ~60 s with `wait_timeout`, so the barrier repeats
   * round by round within this budget; spent → the run is `degraded` with
   * reason `barrier-timeout` (bd tea-rags-mcp-yf4je).
   */
  writeBarrierBudgetMs: intWithDefault(DEFAULT_PAYLOAD_WRITE_BARRIER_BUDGET_MS),
  quantizationScalar: booleanFromEnv,
  turboQuant: booleanFromEnvWithDefault(true),
  // Strict-mode OOM guard: reject memory-consuming writes above N% resident RAM.
  // Unset = off. Mirrors `optionalPositiveInt` but bounded to the 1-100 percent range.
  maxResidentMemoryPercent: z
    .string()
    .optional()
    .transform((v) => (v !== undefined && v !== "" ? parseInt(v, 10) : undefined))
    .pipe(z.number().int().min(1).max(100).optional()),
  // Cap batch-search query size. Unset = no cap.
  searchMaxBatchsize: optionalPositiveInt,
  // Force the embedded daemon to keep storage on disk to minimize RAM (default false).
  lowMemory: booleanFromEnvWithDefault(false),
});

/**
 * The file classifier's operator knobs (bd tea-rags-mcp-82ztq), installed into
 * the classifier by `createAppContext`. Process-owned: read straight from the
 * env source, outside the registry env mechanism (no `REGISTRY_ENV_GROUPS`
 * entry, never in `explicitEnvKeys`) — as they were when the classifier read
 * them itself.
 */
export const fileClassificationSchema = z.object({
  /** `TEA_RAGS_GENERATED_PATTERNS` — comma-separated gitignore globs, appended to the built-in generated set. */
  userGeneratedPatterns: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** `TEA_RAGS_MINIFIED_LINE_THRESHOLD` — a positive integer; anything else keeps the default. */
  minifiedLineLength: z
    .string()
    .optional()
    .transform((raw) => {
      if (raw !== undefined && raw.trim() !== "") {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      return DEFAULT_MINIFIED_LINE_LENGTH;
    }),
});

export type CoreConfig = z.infer<typeof coreSchema>;
export type IngestTuneConfig = z.infer<typeof ingestTuneSchema>;
export type IngestConfig = z.infer<typeof ingestSchema>;
export type CodegraphConfig = z.infer<typeof codegraphSchema>;
export type FileClassificationConfig = z.infer<typeof fileClassificationSchema>;

// These types are defined in core/contracts — Zod schemas stay here, interfaces live there
export type {
  EmbeddingTuneConfig,
  EmbeddingConfig,
  TrajectoryGitConfig,
  VcsConfig,
  QdrantTuneConfig,
} from "../../core/contracts/types/config.js";
