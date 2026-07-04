/**
 * bd tea-rags-mcp-82va1 — run-scoped commit-discovery matrix.
 *
 * ONE repo-wide `git log --since --numstat` per indexing run replaces the K
 * per-batch pathspec logs the chunk-churn walk used to pay (~131ms–0.9s each).
 * The parsed commit → changedFiles matrix is a superset of every pathspec
 * slice — the walk already filters changedFiles against its chunk map — so
 * per-batch walks slice it in-memory via `commitsForFiles` and consume ONE
 * shared `bugFixShaSet` via `getBugFixShas`.
 *
 * An optional persistent tier (`GitCommitDiscoveryPersistence`) keyed
 * (repoRoot, HEAD) amortizes the log across runs: an exact-HEAD hit skips the
 * log entirely; a prior-HEAD ancestor snapshot is topped up via
 * `git log oldHead..newHead`; anything stale/corrupt/drifted rebuilds fully.
 */

import { getCommitsInRange, getCommitsSince, getHead, isAncestor } from "../../../../adapters/vcs/git/git-cli/client.js";
import type { CommitInfo } from "../../../../adapters/vcs/types.js";
import { isDebug } from "../../../../infra/runtime.js";
import { buildBugFixShaSet } from "./merge-branch-resolver.js";

/** One matrix row: a commit plus every file its numstat touched. */
export interface GitCommitDiscoveryEntry {
  commit: CommitInfo;
  changedFiles: string[];
}

/** On-disk snapshot shape of a discovery matrix (see GitCommitDiscoveryStore). */
export interface PersistedGitCommitDiscovery {
  version: 1;
  repoRoot: string;
  head: string;
  sinceIso: string;
  entries: GitCommitDiscoveryEntry[];
}

/** Persistence seam — the concrete store lives in commit-discovery-store.ts. */
export interface GitCommitDiscoveryPersistence {
  /** Exact (repoRoot, head) snapshot, or null when absent/invalid. */
  load: (repoRoot: string, head: string) => PersistedGitCommitDiscovery | null;
  /** Newest snapshot for the repo regardless of head, or null. */
  loadLatest: (repoRoot: string) => PersistedGitCommitDiscovery | null;
  /** Best-effort write — failures are swallowed by the store. */
  save: (repoRoot: string, head: string, sinceIso: string, entries: GitCommitDiscoveryEntry[]) => void;
}

export interface GitCommitDiscoveryOptions {
  /** Window size — the EXACT legacy walk-commits formula is replicated. */
  maxAgeMonths: number;
  /** Timeout for each underlying git log call. */
  timeoutMs: number;
  /** Optional persistent tier; absent ⇒ in-memory single-run discovery. */
  store?: GitCommitDiscoveryPersistence;
}

/**
 * A persisted window is accepted while it lags the wanted window by at most
 * this much — bounds staleness without rebuilding on every run (the window's
 * lower bound slides forward with Date.now()). A config change of
 * maxAgeMonths shifts the wanted window by ≥ a month and auto-invalidates.
 */
const SINCE_DRIFT_TOLERANCE_MS = 24 * 60 * 60 * 1000;

interface DiscoveryMatrix {
  entries: GitCommitDiscoveryEntry[];
  /** Inverted index: filePath → indices into `entries` (ascending = log order). */
  byFile: Map<string, number[]>;
  bugFixShas: Set<string>;
}

export class GitCommitDiscovery {
  /**
   * Lazy single-flight matrix. A FAILED build stays cached — a broken repo
   * fails once for the run, not once per batch; callers (the walk) treat the
   * rejection as "no churn" for their batch.
   */
  private matrixPromise?: Promise<DiscoveryMatrix>;

  constructor(
    private readonly repoRoot: string,
    private readonly opts: GitCommitDiscoveryOptions,
  ) {}

  /**
   * Slice the matrix for a batch's file set. Returns FULL rows (complete
   * changedFiles) in original log order (newest→oldest) — the walk filters
   * changedFiles against its chunk map exactly as it does for pathspec output.
   */
  async commitsForFiles(filePaths: string[]): Promise<GitCommitDiscoveryEntry[]> {
    const matrix = await this.getMatrix();
    const indices = new Set<number>();
    for (const filePath of filePaths) {
      const rows = matrix.byFile.get(filePath);
      if (!rows) continue;
      for (const i of rows) indices.add(i);
    }
    return Array.from(indices)
      .sort((a, b) => a - b)
      .map((i) => matrix.entries[i]);
  }

  /**
   * ONE shared bug-fix SHA set built over ALL matrix commits — superset
   * semantics vs the legacy per-batch set. Identical today: the parser drops
   * merge commits (no numstat without `-m`) from BOTH the legacy pathspec
   * output and the repo-wide output, so `buildBugFixShaSet` sees only
   * single-parent commits either way and both produce the same set.
   */
  async getBugFixShas(): Promise<Set<string>> {
    return (await this.getMatrix()).bugFixShas;
  }

  private async getMatrix(): Promise<DiscoveryMatrix> {
    return (this.matrixPromise ??= this.buildMatrix());
  }

  private async buildMatrix(): Promise<DiscoveryMatrix> {
    // Frozen ONCE at first dispatch with the EXACT legacy per-batch formula
    // (walk-commits.ts) — freezing is more consistent than legacy per-batch
    // millisecond drift.
    const effectiveMonths = this.opts.maxAgeMonths > 0 ? this.opts.maxAgeMonths : 120;
    const sinceDate = new Date(Date.now() - effectiveMonths * 30 * 86400 * 1000);

    const entries = await this.resolveEntries(sinceDate);

    const byFile = new Map<string, number[]>();
    entries.forEach((entry, index) => {
      for (const filePath of entry.changedFiles) {
        const rows = byFile.get(filePath);
        if (rows) rows.push(index);
        else byFile.set(filePath, [index]);
      }
    });

    return { entries, byFile, bugFixShas: buildBugFixShaSet(entries.map((e) => e.commit)) };
  }

  private async resolveEntries(sinceDate: Date): Promise<GitCommitDiscoveryEntry[]> {
    const { store, timeoutMs } = this.opts;
    const head = await getHead(this.repoRoot);
    const wantedSinceMs = sinceDate.getTime();
    const withinTolerance = (sinceIso: string): boolean =>
      Math.abs(wantedSinceMs - Date.parse(sinceIso)) <= SINCE_DRIFT_TOLERANCE_MS;

    if (store) {
      // 1. Exact-HEAD hit — accept only within window tolerance; no re-save.
      const exact = store.load(this.repoRoot, head);
      if (exact && withinTolerance(exact.sinceIso)) return exact.entries;

      // 2. Prior-HEAD top-up — ancestor snapshot + `git log old..new`. The
      //    range old..new structurally excludes duplicates; the window is
      //    inherited from the prior snapshot, so drift accrues until the
      //    tolerance forces a full rebuild.
      const prior = store.loadLatest(this.repoRoot);
      if (
        prior &&
        prior.head !== head &&
        withinTolerance(prior.sinceIso) &&
        (await isAncestor(this.repoRoot, prior.head, head))
      ) {
        try {
          const fresh = await getCommitsInRange(this.repoRoot, prior.head, head, sinceDate, timeoutMs);
          const merged = [...fresh, ...prior.entries];
          store.save(this.repoRoot, head, prior.sinceIso, merged);
          return merged;
        } catch (error) {
          // Range log failed (gc'd sha, transient git error) — fall through
          // to the full rebuild below.
          if (isDebug()) {
            console.error(
              `[ChunkChurn] discovery top-up failed, rebuilding fully:`,
              error instanceof Error ? error.message : error,
            );
          }
        }
      }
    }

    // 3. Full repo-wide discovery.
    const entries = await getCommitsSince(this.repoRoot, sinceDate, timeoutMs);
    store?.save(this.repoRoot, head, sinceDate.toISOString(), entries);
    return entries;
  }
}
