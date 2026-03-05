import { homedir } from "node:os";
import { join } from "node:path";

const APP_DIR_NAME = ".tea-rags-mcp";

export function appDataDir(): string {
  return join(homedir(), APP_DIR_NAME);
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
