/**
 * On-disk state of the background client update (bd tea-rags-mcp-c2dr6) —
 * `<dataDir>/client-update-state.json`: the throttle and backoff stamps the
 * prime-side trigger reads, and the one-line hint a background run leaves for
 * prime when it refused a step only a person may take.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ClientUpdateRunState {
  /** When prime last spawned a background run, epoch ms — debounces spawns while one is still running. */
  lastSpawnAt?: number;
  /** When a background run last finished without failing (installed, nothing eligible, dev install), epoch ms. */
  lastCompletedAt?: number;
  /** When a background run last failed, epoch ms. */
  lastFailureAt?: number;
  /** Failures since the last completed run — scales the backoff. */
  consecutiveFailures: number;
  /** One line prime prints until a manual `tea-rags update` succeeds. */
  manualUpdateHint?: string;
}

export function clientUpdateStatePath(dataDir: string): string {
  return join(dataDir, "client-update-state.json");
}

export function clientUpdateLogPath(dataDir: string): string {
  return join(dataDir, "logs", "client-update.log");
}

export class ClientUpdateStateStore {
  constructor(readonly path: string) {}

  /** The stored state; a missing or corrupt file reads as a fresh state. Never throws. */
  read(): ClientUpdateRunState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return parseClientUpdateRunState(parsed);
    } catch {
      return { consecutiveFailures: 0 };
    }
  }

  /** Merges `patch` into the stored state; a key patched to undefined is removed. Best-effort. */
  update(patch: Partial<ClientUpdateRunState>): void {
    try {
      const next = { ...this.read(), ...patch };
      mkdirSync(dirname(this.path), { recursive: true });
      const staging = `${this.path}.${process.pid}.tmp`;
      writeFileSync(staging, JSON.stringify(next));
      renameSync(staging, this.path);
    } catch {
      // A stamp that cannot be written only costs an extra spawn later.
    }
  }
}

function parseClientUpdateRunState(value: unknown): ClientUpdateRunState {
  if (typeof value !== "object" || value === null) return { consecutiveFailures: 0 };
  const v = value as Record<string, unknown>;
  const num = (key: string): number | undefined => (typeof v[key] === "number" ? v[key] : undefined);
  const state: ClientUpdateRunState = { consecutiveFailures: num("consecutiveFailures") ?? 0 };
  for (const key of ["lastSpawnAt", "lastCompletedAt", "lastFailureAt"] as const) {
    const at = num(key);
    if (at !== undefined) state[key] = at;
  }
  if (typeof v.manualUpdateHint === "string") state.manualUpdateHint = v.manualUpdateHint;
  return state;
}
