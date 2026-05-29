import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  booleanFromEnv,
  booleanFromEnvWithDefault,
  floatWithDefault,
  intWithDefault,
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
});

export const embeddingTuneSchema = z.object({
  batchSize: intWithDefault(1024),
  minBatchSize: optionalInt,
  batchTimeoutMs: intWithDefault(2000),
  maxRequestsPerMinute: optionalPositiveInt,
  retryAttempts: intWithDefault(3),
  retryDelayMs: intWithDefault(1000),
});

export const embeddingSchema = z.object({
  provider: z.enum(["ollama", "openai", "cohere", "voyage", "onnx"]).default("ollama"),
  model: z.string().optional(),
  dimensions: optionalPositiveInt,
  device: z.string().optional().default("auto"),
  baseUrl: z.string().optional(),
  fallbackBaseUrl: z.string().optional(),
  ollamaLegacyApi: booleanFromEnv,
  ollamaNumGpu: intWithDefault(999),
  openaiApiKey: z.string().optional(),
  cohereApiKey: z.string().optional(),
  voyageApiKey: z.string().optional(),
  tune: embeddingTuneSchema,
});

export const ingestTuneSchema = z.object({
  pipelineConcurrency: intWithDefault(1),
  chunkerPoolSize: intWithDefault(4),
  fileConcurrency: intWithDefault(50),
  ioConcurrency: intWithDefault(50),
  /**
   * Worker-pool thread count for the enrichment executor. Production runs
   * through `WorkerPoolEnrichmentExecutor` unconditionally — there is no
   * inline/worker toggle. `InlineEnrichmentExecutor` is the **internal test
   * seam** used by integration tests + recovery scenarios that construct
   * `IngestFacade` directly with their own executor in deps.
   *
   * Default 4 mirrors `chunkerPoolSize` sizing — operators can override via
   * `INGEST_TUNE_ENRICHMENT_POOL_SIZE` or `ENRICHMENT_POOL_SIZE`.
   */
  enrichmentPoolSize: intWithDefault(4),
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
  chunkConcurrency: intWithDefault(10),
  chunkMaxAgeMonths: floatWithDefault(6),
  chunkTimeoutMs: intWithDefault(120000),
  chunkMaxFileLines: intWithDefault(10000),
  squashAwareSessions: booleanFromEnv,
  sessionGapMinutes: intWithDefault(30),
});

export const codegraphSchema = z.object({
  /** Master switch for the codegraph trajectory family (Slice 1: TS symbols). */
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
   * Number of DuckDB worker threads per collection. Default 2 — the
   * codegraph workload is bottlenecked on the writer transaction lock,
   * not parallel scan, so additional threads inflate memory without
   * speeding indexing.
   */
  dbThreads: intWithDefault(2),
  /**
   * When true (default), test files are excluded from codegraph
   * extraction via `CODEGRAPH_TEST_PATTERNS`. Test files remain indexed
   * by the main Qdrant ingest path — this flag only gates the
   * dependency-graph extraction. Setting `CODEGRAPH_EXCLUDE_TESTS=false`
   * includes tests in fan-graph / PageRank / cycles.
   */
  excludeTests: booleanFromEnvWithDefault(true),
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
});

export const qdrantTuneSchema = z.object({
  upsertBatchSize: intWithDefault(100),
  upsertFlushIntervalMs: intWithDefault(500),
  upsertOrdering: z.enum(["weak", "medium", "strong"]).default("weak"),
  deleteBatchSize: intWithDefault(500),
  deleteConcurrency: intWithDefault(8),
  deleteFlushTimeoutMs: intWithDefault(1000),
  quantizationScalar: booleanFromEnv,
});

export type CoreConfig = z.infer<typeof coreSchema>;
export type IngestTuneConfig = z.infer<typeof ingestTuneSchema>;
export type IngestConfig = z.infer<typeof ingestSchema>;
export type CodegraphConfig = z.infer<typeof codegraphSchema>;

// These types are defined in core/contracts — Zod schemas stay here, interfaces live there
export type {
  EmbeddingTuneConfig,
  EmbeddingConfig,
  TrajectoryGitConfig,
  QdrantTuneConfig,
} from "../../core/contracts/types/config.js";
