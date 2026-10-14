import { homedir } from "node:os";
import { join } from "node:path";

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

export function daemonSocketPath(): string {
  return join(appDataDir(), "onnx.sock");
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
