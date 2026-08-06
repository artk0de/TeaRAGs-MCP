/**
 * IndexFreshnessCheck — the auto-update watcher's decision module (hpg2).
 *
 * Pure policy: given a registry entry and the repo's live git state, decide
 * whether a background reindex may fire. It deliberately does NOT detect file
 * changes — under background + stale-serve semantics the change detector is
 * `reindexChanges` itself (Merkle delta; `hasNoChanges` → cheap no-op), so
 * this check stays ~1 ms (registry read + `.git/HEAD` read) and can run on
 * every MCP tool call. The indexing marker/lock is NOT consulted here either:
 * the detached updater re-checks and acquires it authoritatively (spec §4).
 *
 * Spec: docs/specs/2026-08-06-auto-update-watcher-design.md §2.
 */

import type { CollectionEntry } from "../../../contracts/types/registry.js";
import { readRepoGitState } from "../../../infra/repo-git-state.js";

/** Trigger-side debounce: skip when the last run finished under this ago. */
export const AUTO_UPDATE_RUN_TTL_MS = 120_000;
/**
 * Failure backoff: a failed run (embedding endpoint down, crash) suppresses
 * respawns for longer, mirroring the negative-TTL pattern in
 * `cli/update-check`. Prevents a respawn storm on every tool call while the
 * failure cause persists.
 */
export const AUTO_UPDATE_FAILURE_BACKOFF_MS = 300_000;

export type IndexFreshnessVerdict =
  | { kind: "eligible"; entry: CollectionEntry }
  | { kind: "branch-mismatch"; head: string | null; targetBranch: string }
  | { kind: "transient" }
  | { kind: "disabled" }
  | { kind: "debounced"; reason: "recent-run" | "failure-backoff" }
  | { kind: "not-a-repo" };

export interface IndexFreshnessCheckDeps {
  /** Injectable for tests; production default reads `.git` files directly. */
  readGitState: typeof readRepoGitState;
  clock: () => number;
}

export class IndexFreshnessCheck {
  private readonly deps: IndexFreshnessCheckDeps;

  constructor(deps?: Partial<IndexFreshnessCheckDeps>) {
    this.deps = {
      readGitState: deps?.readGitState ?? readRepoGitState,
      clock: deps?.clock ?? (() => Date.now()),
    };
  }

  /**
   * Pure decision, first match wins:
   * disabled → not-a-repo → transient → branch-mismatch → debounced → eligible.
   * Never throws — callers fire it on every search-tool response.
   */
  check(entry: CollectionEntry): IndexFreshnessVerdict {
    const { autoUpdate } = entry;
    if (!autoUpdate?.enabled) return { kind: "disabled" };

    const state = this.deps.readGitState(entry.path);
    if (state === null) return { kind: "not-a-repo" };
    if (state.transient) return { kind: "transient" };
    if (state.branch !== autoUpdate.targetBranch) {
      return { kind: "branch-mismatch", head: state.branch, targetBranch: autoUpdate.targetBranch };
    }

    const { lastRun } = autoUpdate;
    if (lastRun !== undefined) {
      const lastRunAt = Date.parse(lastRun.at);
      if (!Number.isNaN(lastRunAt)) {
        const elapsed = this.deps.clock() - lastRunAt;
        if (lastRun.outcome === "failed" && elapsed < AUTO_UPDATE_FAILURE_BACKOFF_MS) {
          return { kind: "debounced", reason: "failure-backoff" };
        }
        if (elapsed < AUTO_UPDATE_RUN_TTL_MS) {
          return { kind: "debounced", reason: "recent-run" };
        }
      }
    }

    return { kind: "eligible", entry };
  }
}
