/**
 * Prime-side trigger of the background client update (bd tea-rags-mcp-c2dr6).
 * Cheap and never blocking: reads the setting and the state file, then
 * fire-and-forget spawns `tea-rags update --background` at most once per 24 h,
 * backing off after failures. Mirrors the per-project AutoUpdateTrigger.
 */

import type { ClientAutoUpdateSetting } from "./settings.js";
import type { ClientUpdateRunState, ClientUpdateStateStore } from "./state-store.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
export const CLIENT_UPDATE_INTERVAL_MS = 24 * HOUR_MS;
/** A run spawned this recently may still be running — do not start another. */
export const CLIENT_UPDATE_SPAWN_DEBOUNCE_MS = 10 * MINUTE_MS;
const BACKOFF_BASE_MS = HOUR_MS;

export type ClientUpdateTriggerOutcome = "disabled" | "spawned" | "throttled" | "backoff" | "in-flight";

export interface ClientUpdateTriggerDeps {
  setting: () => ClientAutoUpdateSetting;
  store: Pick<ClientUpdateStateStore, "read" | "update">;
  /** Detached spawn of `tea-rags update --background`, log fd already applied. */
  spawn: () => void;
  clock: () => number;
}

export class ClientUpdateTrigger {
  constructor(private readonly deps: ClientUpdateTriggerDeps) {}

  /** Fire-and-forget. Never throws: a broken trigger must not break prime. */
  maybeSpawn(): ClientUpdateTriggerOutcome {
    try {
      if (!this.deps.setting().enabled) return "disabled";
      const now = this.deps.clock();
      const verdict = clientUpdateSpawnVerdict(this.deps.store.read(), now);
      if (verdict !== "spawned") return verdict;
      this.deps.store.update({ lastSpawnAt: now });
      this.deps.spawn();
      return "spawned";
    } catch {
      return "disabled";
    }
  }

  /** The hint a background run left (a step it refused), while automatic updates are on. */
  manualUpdateHint(): string | null {
    try {
      if (!this.deps.setting().enabled) return null;
      return this.deps.store.read().manualUpdateHint ?? null;
    } catch {
      return null;
    }
  }
}

function clientUpdateSpawnVerdict(
  state: ClientUpdateRunState,
  now: number,
): Exclude<ClientUpdateTriggerOutcome, "disabled"> {
  if (state.lastSpawnAt !== undefined && now - state.lastSpawnAt < CLIENT_UPDATE_SPAWN_DEBOUNCE_MS) return "in-flight";
  if (state.lastFailureAt !== undefined && state.consecutiveFailures > 0) {
    const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (state.consecutiveFailures - 1), CLIENT_UPDATE_INTERVAL_MS);
    if (now - state.lastFailureAt < backoffMs) return "backoff";
  }
  if (state.lastCompletedAt !== undefined && now - state.lastCompletedAt < CLIENT_UPDATE_INTERVAL_MS) {
    return "throttled";
  }
  return "spawned";
}
