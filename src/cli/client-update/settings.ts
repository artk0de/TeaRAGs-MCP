/**
 * Machine-wide "client auto-update" setting (bd tea-rags-mcp-c2dr6): whether
 * `tea-rags prime` may update the tea-rags client itself in the background.
 * Not the per-project index auto-update (`tea-rags auto-update …`), which is a
 * registry field.
 *
 * Stored as `clientAutoUpdate` in `<dataDir>/settings.json`, default on;
 * `TEA_RAGS_AUTO_UPDATE=0|1` wins over the file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClientAutoUpdateSetting {
  enabled: boolean;
  /** What decided `enabled` — the env override, settings.json, or the built-in default. */
  source: "env" | "file" | "default";
}

export const CLIENT_AUTO_UPDATE_ENV = "TEA_RAGS_AUTO_UPDATE";
const SETTINGS_KEY = "clientAutoUpdate";

const ENV_ON = new Set(["1", "true", "on", "yes"]);
const ENV_OFF = new Set(["0", "false", "off", "no"]);

/** `$TEA_RAGS_DATA_DIR`, else `~/.tea-rags`. */
export function clientUpdateDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

export function readClientAutoUpdateSetting(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ClientAutoUpdateSetting {
  const raw = env[CLIENT_AUTO_UPDATE_ENV]?.trim().toLowerCase();
  if (raw !== undefined && ENV_ON.has(raw)) return { enabled: true, source: "env" };
  if (raw !== undefined && ENV_OFF.has(raw)) return { enabled: false, source: "env" };

  const stored = readSettingsFile(dataDir)[SETTINGS_KEY];
  if (typeof stored === "boolean") return { enabled: stored, source: "file" };
  return { enabled: true, source: "default" };
}

/** Persists the flag, keeping every other key of settings.json. Throws when the file cannot be written. */
export function writeClientAutoUpdateSetting(dataDir: string, enabled: boolean): void {
  const settings = { ...readSettingsFile(dataDir), [SETTINGS_KEY]: enabled };
  mkdirSync(dataDir, { recursive: true });
  const target = settingsPath(dataDir);
  const staging = `${target}.${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(staging, target);
}

function settingsPath(dataDir: string): string {
  return join(dataDir, "settings.json");
}

/** The parsed settings object; a missing, unreadable or non-object file reads as empty. */
function readSettingsFile(dataDir: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(dataDir), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
