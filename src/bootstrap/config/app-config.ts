/**
 * AppConfig — resolves Zod config slices into the typed AppConfig structure.
 */

import type { IngestCodeConfig, TrajectoryIngestConfig } from "../../core/types.js";
import { ConfigNotInitializedError } from "../errors.js";
import { DEFAULT_CODE_EXTENSIONS, DEFAULT_IGNORE_PATTERNS } from "./defaults.js";
import { parseAppConfigZod } from "./parse.js";
import { appDataDir, daemonPidFile, daemonSocketPath, logsDir, modelsDir, snapshotsDir } from "./paths.js";
import type { VcsConfig } from "./schemas.js";

export interface ResolvedPaths {
  appData: string;
  snapshots: string;
  logs: string;
  models: string;
  daemonSocket: string;
  daemonPid: string;
}

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
  vcs: VcsConfig;
  paths: ResolvedPaths;
}

let _lastZodConfig: ReturnType<typeof parseAppConfigZod> | null = null;

/** Get the full Zod config from the last parseAppConfig() call */
export function getZodConfig(): ReturnType<typeof parseAppConfigZod> {
  if (!_lastZodConfig) throw new ConfigNotInitializedError("zodConfig", "parseAppConfig");
  return _lastZodConfig;
}

export function parseAppConfig(): AppConfig {
  const zodConfig = parseAppConfigZod();
  _lastZodConfig = zodConfig;
  return buildAppConfig(zodConfig);
}

/**
 * Bridge an already-parsed Zod config to the typed AppConfig consumers use.
 *
 * Split out from `parseAppConfig` because the MCP server bridges a config it
 * parsed from a PROJECT's registry env — re-reading process.env there would
 * hand the run the server's values, which is the bug this exists to close
 * (tea-rags-mcp-pmfm4). Pure: the only environment it touches is the path
 * resolution, which is process-owned by definition.
 */
export function buildAppConfig(zodConfig: ReturnType<typeof parseAppConfigZod>): AppConfig {
  const paths: ResolvedPaths = {
    appData: appDataDir(),
    snapshots: snapshotsDir(),
    logs: logsDir(),
    models: modelsDir(),
    daemonSocket: daemonSocketPath(),
    daemonPid: daemonPidFile(),
  };

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
      quantizationScalar: zodConfig.qdrantTune.quantizationScalar,
      turboQuant: zodConfig.qdrantTune.turboQuant,
      enableGitMetadata: zodConfig.trajectoryGit.enabled,
      userSetChunkSize: zodConfig.flags.userSetChunkSize,
      maxChunksPerFile: undefined,
      maxTotalChunks: undefined,
    },
    vcs: zodConfig.vcs,
    paths,
    trajectoryIngest: {
      enableGitMetadata: zodConfig.trajectoryGit.enabled,
      squashAwareSessions: zodConfig.trajectoryGit.squashAwareSessions,
      sessionGapMinutes: zodConfig.trajectoryGit.sessionGapMinutes,
      trajectoryGit: {
        logMaxAgeMonths: zodConfig.trajectoryGit.logMaxAgeMonths,
        logTimeoutMs: zodConfig.trajectoryGit.logTimeoutMs,
        chunkConcurrency: zodConfig.trajectoryGit.chunkConcurrency,
        blamePoolSize: zodConfig.trajectoryGit.blamePoolSize,
        chunkMaxAgeMonths: zodConfig.trajectoryGit.chunkMaxAgeMonths,
        chunkTimeoutMs: zodConfig.trajectoryGit.chunkTimeoutMs,
        chunkMaxFileLines: zodConfig.trajectoryGit.chunkMaxFileLines,
      },
    },
  };
}
