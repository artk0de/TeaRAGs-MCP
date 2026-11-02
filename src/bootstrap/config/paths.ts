import { homedir } from "node:os";
import { join } from "node:path";

import { boundedUnixSocketPath } from "../../core/adapters/filesystem/unix-socket-path.js";

const APP_DIR_NAME = ".tea-rags";

export function appDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), APP_DIR_NAME);
}

export function snapshotsDir(): string {
  return join(appDataDir(), "snapshots");
}

export function logsDir(): string {
  return join(appDataDir(), "logs");
}

export function modelsDir(): string {
  return join(appDataDir(), "models");
}

/**
 * The ONNX daemon socket. Kept within the platform's unix socket path bound by
 * the guard the codegraph daemon uses (bd tea-rags-mcp-64j9p): a long
 * TEA_RAGS_DATA_DIR moves it under a short per-user tmp alias of the app-data
 * dir, which the daemon creates before `listen` (`OnnxDaemon` `socketHomeDir`).
 */
export function daemonSocketPath(): string {
  return boundedUnixSocketPath(appDataDir(), "onnx.sock");
}

export function daemonPidFile(): string {
  return join(appDataDir(), "onnx-daemon.pid");
}

/** Cross-process "embedding endpoint down" verdicts (bd w1bz7). */
export function embeddingEndpointHealthPath(): string {
  return join(appDataDir(), "embedding-endpoint-health.json");
}

export function calibrationCachePath(): string {
  return join(appDataDir(), "onnx-calibration.json");
}
