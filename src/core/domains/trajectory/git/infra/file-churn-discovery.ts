/**
 * Incremental delta-merge + window-eviction commit cache for per-file churn.
 *
 * The FILE analogue of `GitCommitDiscovery` (chunk path): both resolve a
 * window of commits with the same three-tier staleness logic — exact-HEAD
 * store hit → return; prior-HEAD ancestor snapshot → `readCommitFileNumstat`
 * range top-up + merge; anything stale/drifted → full repo-wide read. This one
 * consumes `readCommitFileNumstat` (numstat-preserving) instead of
 * `getCommitsSince`/`getCommitsInRange`, and adds two steps the chunk path
 * lacks: EVICT commits below the window's lower bound and AGGREGATE the
 * surviving `CommitFileNumstat[]` into `Map<string, FileChurnData>`.
 *
 * Windowed-equality invariant: a warm-cache incremental `fileChurn()` MUST
 * equal a cold full recompute for the same HEAD+window — same `commits[]`
 * order, `linesAdded`, `linesDeleted` per file. The merge is `[...fresh,
 * ...prior.entries]` (fresh range commits newest→oldest, then the prior
 * snapshot), which reconstructs the exact newest→oldest sequence a single full
 * `readCommitFileNumstat` returns; aggregation folds in that order so each
 * file's `commits[]` matches the cold `parseNumstatOutput` push order.
 */

import type { VcsGitAdapter } from "../../../../adapters/vcs/git/adapter.js";
import type { CommitFileNumstat, FileChurnData } from "../../../../adapters/vcs/types.js";
import { isDebug } from "../../../../infra/runtime.js";

/** On-disk snapshot shape of a file-churn window (see FileChurnDiscoveryStore). */
export interface PersistedFileChurnDiscovery {
  version: 1;
  repoRoot: string;
  head: string;
  sinceIso: string;
  entries: CommitFileNumstat[];
}

/** Persistence seam — the concrete store lives in file-churn-discovery-store.ts. */
export interface FileChurnDiscoveryPersistence {
  /** Exact (repoRoot, head) snapshot, or null when absent/invalid. */
  load: (repoRoot: string, head: string) => PersistedFileChurnDiscovery | null;
  /** Newest snapshot for the repo regardless of head, or null. */
  loadLatest: (repoRoot: string) => PersistedFileChurnDiscovery | null;
  /** Best-effort write — failures are swallowed by the store. */
  save: (repoRoot: string, head: string, sinceIso: string, entries: CommitFileNumstat[]) => void;
}

export interface FileChurnDiscoveryOptions {
  /** Window size — the EXACT legacy walk-commits formula is replicated. */
  maxAgeMonths: number;
  /** Timeout for each underlying git log call. */
  timeoutMs: number;
  /** Optional persistent tier; absent ⇒ in-memory single-run discovery. */
  store?: FileChurnDiscoveryPersistence;
}

/**
 * A persisted window is accepted while it lags the wanted window by at most
 * this much — bounds staleness without rebuilding on every run (the window's
 * lower bound slides forward with Date.now()). A config change of
 * maxAgeMonths shifts the wanted window by ≥ a month and auto-invalidates.
 */
const SINCE_DRIFT_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export class FileChurnDiscovery {
  /** Resolved lazily in resolveEntries — mirrors GitCommitDiscovery so the
   *  provider's async adapter factory hands over a Promise while tests stay
   *  constructible without awaiting. */
  private readonly adapter: Promise<VcsGitAdapter>;

  /**
   * Single-flight latch — mirrors GitCommitDiscovery's `matrixPromise`. Repeated
   * `fileChurn()` calls in one run share ONE resolve+aggregate (one git
   * subprocess, one `store.save`); a failed build stays cached for the run.
   */
  private churnPromise?: Promise<Map<string, FileChurnData>>;

  constructor(
    adapter: VcsGitAdapter | Promise<VcsGitAdapter>,
    private readonly opts: FileChurnDiscoveryOptions,
  ) {
    this.adapter = Promise.resolve(adapter);
  }

  /**
   * Whole-repo per-file churn aggregate over the window: resolve (with the
   * store's incremental delta-merge when present), evict aged-out commits,
   * canonicalize the fold order, then aggregate into `Map<string, FileChurnData>`.
   * Latched — one build per instance per run.
   */
  async fileChurn(): Promise<Map<string, FileChurnData>> {
    // Single-flight, but do NOT memoize a REJECTION for the instance's life. The
    // provider caches one FileChurnDiscovery per root until finalize; latching a
    // rejected promise would poison every later streaming batch after a single
    // transient git failure (pre-feature, `readNumstatLog` retried per batch).
    // Clearing the latch in the failure tail lets concurrent callers still SHARE
    // the in-flight promise while a LATER (non-concurrent) call retries.
    if (!this.churnPromise) {
      this.churnPromise = this.computeFileChurn().catch((error) => {
        this.churnPromise = undefined;
        throw error;
      });
    }
    return this.churnPromise;
  }

  private async computeFileChurn(): Promise<Map<string, FileChurnData>> {
    // Frozen ONCE with the EXACT legacy per-batch formula (walk-commits.ts).
    const effectiveMonths = this.opts.maxAgeMonths > 0 ? this.opts.maxAgeMonths : 120;
    const sinceDate = new Date(Date.now() - effectiveMonths * 30 * 86400 * 1000);

    const entries = await this.resolveEntries(sinceDate);

    // EVICT: git timestamps are epoch SECONDS. A topped-up / drift-tolerated
    // window can carry commits below the current lower bound; those contribute
    // ZERO. Compare in seconds against the same frozen `sinceDate`.
    const lowerBoundSec = Math.floor(sinceDate.getTime() / 1000);

    // CANONICALIZE: evict aged-out commits, then sort by (committerTimestamp
    // desc, sha asc) BEFORE aggregating. Window membership AND order key off the
    // COMMITTER date (`%ct`), NOT the author date (`commit.timestamp` = `%at`),
    // because `git log --since` (the legacy `readNumstatLog` full recompute)
    // filters on committer date: on rebased / cherry-picked / squash-merged
    // history (author date ≪ committer date) an author-date evict would drop a
    // commit the legacy path KEEPS, diverging commitCount / lines / sha-set.
    // Sorting by committer date also matches git-log's own reverse-chronological
    // order, so the union `[...fresh, ...prior]` — the correct SET but not
    // git-log's order under MERGES (a top-up range `prior.head..head` can
    // surface a side-branch commit dated among the prior window) — folds into
    // the SAME canonical order on both the warm and cold path → `commits[]` is
    // byte-identical (windowed-equality holds split-independently) and the
    // tie-break-sensitive derived signals (recentDominantAuthor / lastCommitHash
    // / taskId order) are stable. `filter` yields a fresh array, so the `.sort`
    // never mutates the array `resolveEntries` already persisted via `store.save`.
    const ordered = entries
      .filter((entry) => entry.committerTimestamp >= lowerBoundSec)
      .sort((a, b) => b.committerTimestamp - a.committerTimestamp || a.commit.sha.localeCompare(b.commit.sha));

    // AGGREGATE in canonical order — each file's `commits[]` is deterministic.
    const fileMap = new Map<string, FileChurnData>();
    for (const entry of ordered) {
      for (const file of entry.files) {
        let churn = fileMap.get(file.path);
        if (!churn) {
          churn = { commits: [], linesAdded: 0, linesDeleted: 0 };
          fileMap.set(file.path, churn);
        }
        churn.commits.push(entry.commit);
        churn.linesAdded += file.added;
        churn.linesDeleted += file.deleted;
      }
    }

    return fileMap;
  }

  private async resolveEntries(sinceDate: Date): Promise<CommitFileNumstat[]> {
    const { store, timeoutMs } = this.opts;
    const adapter = await this.adapter;
    const { repoRoot } = adapter;
    const head = await adapter.getHead();
    const wantedSinceMs = sinceDate.getTime();
    const withinTolerance = (sinceIso: string): boolean =>
      Math.abs(wantedSinceMs - Date.parse(sinceIso)) <= SINCE_DRIFT_TOLERANCE_MS;

    if (store) {
      // 1. Exact-HEAD hit — accept only within window tolerance; no re-save.
      const exact = store.load(repoRoot, head);
      if (exact && withinTolerance(exact.sinceIso)) return exact.entries;

      // 2. Prior-HEAD top-up — ancestor snapshot + `readCommitFileNumstat`
      //    over `prior.head..head`. The range structurally excludes duplicates;
      //    the window is inherited from the prior snapshot, so drift accrues
      //    until the tolerance forces a full rebuild.
      const prior = store.loadLatest(repoRoot);
      if (
        prior &&
        prior.head !== head &&
        withinTolerance(prior.sinceIso) &&
        (await adapter.isAncestor(prior.head, head))
      ) {
        try {
          const fresh = await adapter.readCommitFileNumstat(sinceDate, { fromSha: prior.head, toSha: head }, timeoutMs);
          const merged = [...fresh, ...prior.entries];
          store.save(repoRoot, head, prior.sinceIso, merged);
          return merged;
        } catch (error) {
          // Range log failed (gc'd sha, transient git error) — fall through
          // to the full rebuild below.
          if (isDebug()) {
            console.error(
              `[FileChurn] discovery top-up failed, rebuilding fully:`,
              error instanceof Error ? error.message : error,
            );
          }
        }
      }
    }

    // 3. Full repo-wide discovery — no range narrows the window.
    const entries = await adapter.readCommitFileNumstat(sinceDate, undefined, timeoutMs);
    store?.save(repoRoot, head, sinceDate.toISOString(), entries);
    return entries;
  }
}
