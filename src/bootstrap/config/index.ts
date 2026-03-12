import type { IngestCodeConfig, TrajectoryIngestConfig } from "../../core/types.js";
import { DEFAULT_CODE_EXTENSIONS, DEFAULT_IGNORE_PATTERNS } from "./defaults.js";
import { parseAppConfigZod } from "./parse.js";

export * from "./defaults.js";
export * from "./paths.js";
export * from "./utils.js";
export * from "./schemas.js";
export * from "./parse.js";

export interface AppConfig {
  qdrantUrl?: string;
  qdrantApiKey?: string;
  embeddingProvider: string;
  transportMode: "stdio" | "http";
  httpPort: number;
  requestTimeoutMs: number;
  promptsConfigFile: string;
  ingestCode: IngestCodeConfig;
  trajectoryIngest: TrajectoryIngestConfig;
}

let _lastZodConfig: ReturnType<typeof parseAppConfigZod> | null = null;

/** Get the full Zod config from the last parseAppConfig() call */
export function getZodConfig(): ReturnType<typeof parseAppConfigZod> {
  if (!_lastZodConfig) throw new Error("parseAppConfig() must be called first");
  return _lastZodConfig;
}

export function parseAppConfig(): AppConfig {
  const zodConfig = parseAppConfigZod();
  _lastZodConfig = zodConfig;

  // Bridge Zod slices to typed AppConfig for consumers
  return {
    qdrantUrl: zodConfig.core.qdrantUrl,
    qdrantApiKey: zodConfig.core.qdrantApiKey,
    embeddingProvider: zodConfig.embedding.provider,
    transportMode: zodConfig.core.transportMode,
    httpPort: zodConfig.core.httpPort,
    requestTimeoutMs: zodConfig.core.requestTimeoutMs,
    promptsConfigFile: zodConfig.core.promptsConfigFile,
    ingestCode: {
      chunkSize: zodConfig.ingest.chunkSize,
      chunkOverlap: zodConfig.ingest.chunkOverlap,
      supportedExtensions: DEFAULT_CODE_EXTENSIONS,
      ignorePatterns: DEFAULT_IGNORE_PATTERNS,
      enableHybridSearch: zodConfig.ingest.enableHybrid,
      enableGitMetadata: zodConfig.trajectoryGit.enabled,
      maxChunksPerFile: undefined,
      maxTotalChunks: undefined,
    },
    trajectoryIngest: {
      enableGitMetadata: zodConfig.trajectoryGit.enabled,
      squashAwareSessions: zodConfig.trajectoryGit.squashAwareSessions,
      sessionGapMinutes: zodConfig.trajectoryGit.sessionGapMinutes,
      trajectoryGit: {
        logMaxAgeMonths: zodConfig.trajectoryGit.logMaxAgeMonths,
        logTimeoutMs: zodConfig.trajectoryGit.logTimeoutMs,
        chunkConcurrency: zodConfig.trajectoryGit.chunkConcurrency,
        chunkMaxAgeMonths: zodConfig.trajectoryGit.chunkMaxAgeMonths,
        chunkTimeoutMs: zodConfig.trajectoryGit.chunkTimeoutMs,
        chunkMaxFileLines: zodConfig.trajectoryGit.chunkMaxFileLines,
      },
    },
  };
}
