/**
 * AutoUpdateTrigger — trigger-side orchestration of the auto-update watcher
 * (hpg2, spec §3). One instance per process (MCP server / prime run).
 *
 * `maybeSpawn` is the ONLY entry: cheap in-memory TTL first (so the freshness
 * check does not even run on every tool call), then the registry-backed
 * `IndexFreshnessCheck` verdict (which carries the cross-process debounce via
 * `lastRun`), then a fire-and-forget detached spawn on `eligible`. Never
 * throws and never blocks — the caller is a serving query path.
 */

import {
  AUTO_UPDATE_RUN_TTL_MS,
  type CollectionEntry,
  type IndexFreshnessCheck,
  type IndexFreshnessVerdict,
} from "../../core/api/public/index.js";

export interface AutoUpdateTriggerDeps {
  registry: { get: (collectionName: string) => CollectionEntry | null };
  freshness: Pick<IndexFreshnessCheck, "check">;
  /** Spawner partial-applied with the log fd (see spawnDetachedUpdater). */
  spawn: (project: string) => void;
  clock: () => number;
}

export type AutoUpdateTriggerOutcome = IndexFreshnessVerdict["kind"] | "in-memory-debounced";

export class AutoUpdateTrigger {
  /** collectionName → last check timestamp (in-process TTL). */
  private readonly lastChecked = new Map<string, number>();

  constructor(private readonly deps: AutoUpdateTriggerDeps) {}

  /**
   * Fire-and-forget trigger. Returns the verdict kind so callers (prime
   * digest, MCP response hint) can render state without a second check.
   */
  maybeSpawn(collectionName: string): AutoUpdateTriggerOutcome {
    try {
      const now = this.deps.clock();
      const last = this.lastChecked.get(collectionName);
      if (last !== undefined && now - last < AUTO_UPDATE_RUN_TTL_MS) {
        return "in-memory-debounced";
      }
      this.lastChecked.set(collectionName, now);

      const entry = this.deps.registry.get(collectionName);
      if (entry === null) return "disabled";

      const verdict = this.deps.freshness.check(entry);
      if (verdict.kind === "eligible") {
        this.deps.spawn(collectionName);
      }
      return verdict.kind;
    } catch {
      // Contract: never break the serving query. Treat as silently disabled.
      return "disabled";
    }
  }
}
