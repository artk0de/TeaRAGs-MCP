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
});

export const ingestSchema = z.object({
  chunkSize: intWithDefault(2500),
  chunkOverlap: intWithDefault(300),
  enableAST: booleanFromEnvWithDefault(true),
  enableHybrid: booleanFromEnv,
  tune: ingestTuneSchema,
});

export const trajectoryGitSchema = z.object({
  enabled: booleanFromEnv,
  logMaxAgeMonths: floatWithDefault(12),
  logTimeoutMs: intWithDefault(60000),
  chunkConcurrency: intWithDefault(10),
  chunkMaxAgeMonths: floatWithDefault(6),
  chunkTimeoutMs: intWithDefault(120000),
  chunkMaxFileLines: intWithDefault(10000),
  squashAwareSessions: booleanFromEnv,
  sessionGapMinutes: intWithDefault(30),
});

export const qdrantTuneSchema = z.object({
  upsertBatchSize: intWithDefault(100),
  upsertFlushIntervalMs: intWithDefault(500),
  upsertOrdering: z.enum(["weak", "medium", "strong"]).default("weak"),
  deleteBatchSize: intWithDefault(500),
  deleteConcurrency: intWithDefault(8),
  deleteFlushTimeoutMs: intWithDefault(1000),
});

export type CoreConfig = z.infer<typeof coreSchema>;
export type EmbeddingTuneConfig = z.infer<typeof embeddingTuneSchema>;
export type EmbeddingConfig = z.infer<typeof embeddingSchema>;
export type IngestTuneConfig = z.infer<typeof ingestTuneSchema>;
export type IngestConfig = z.infer<typeof ingestSchema>;
export type TrajectoryGitConfig = z.infer<typeof trajectoryGitSchema>;
export type QdrantTuneConfig = z.infer<typeof qdrantTuneSchema>;
