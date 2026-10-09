/**
 * Low-level git operations — CLI only. No enrichment concepts, no caching.
 *
 * Everything (log walking, object reads, ref resolution) goes through the git
 * CLI. isomorphic-git was removed: its pack reader loaded the ENTIRE packfile
 * into a JS ArrayBuffer (heap profiler caught 3×1.4 GB on a large repo → 16 GB
 * OOM). `git cat-file` / `git rev-parse` stream individual objects from disk,
 * so resident memory never includes the whole pack.
 */
import { execFileSync } from "node:child_process";

import { buildGitChildProcessEnv, resolveGitExecutable } from "../../../../infra/git-executable.js";
import { isDebug } from "../../../../infra/runtime.js";
import type {
  BlameLine,
  CommitChangedPath,
  CommitFileNumstat,
  CommitInfo,
  CommitPathChanges,
  CommitWithChangedFiles,
  FileChurnData,
} from "../../types.js";
import { BULK_LOG_STALL_FLOOR_MS, execFileAsync } from "./exec.js";
import {
  COMMIT_PATH_CHANGES_HEADER,
  parseBlameOutput,
  parseCommitFileNumstat,
  parseCommitPathChanges,
  parseNumstatOutput,
  parsePathspecOutput,
} from "./parsers.js";
import { execWithStallGuard } from "./stall-guard-exec.js";
import { splitNulTerminated, TREE_LISTING_STALL_MS } from "./working-tree.js";

// Moved to sibling modules; re-exported so the client's public surface is unchanged for callers.
export {
  createCatFileBatch,
  createCatFileBatchCheck,
  readBlobAsString,
  readBlobCommitTime,
  type CatFileBatchCheckReader,
  type CatFileBatchReader,
} from "./cat-file.js";
export {
  listChangedFiles,
  listTreePaths,
  listWorktreeDeletions,
  listWorktreeModifications,
  readAddedLineRanges,
  readAddedLineRangesOfFiles,
  readStatusPorcelain,
  readWorkingTreeChanges,
  readWorkingTreeRenames,
  type AddedLineRange,
  type WorkingTreeNameStatus,
  type WorkingTreeRenamePair,
} from "./working-tree.js";

/** Race a promise against a timeout. Rejects with Error(message) on expiry. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

// ── CLI primitives ───────────────────────────────────────────────

/**
 * Run `git log` with pathspec filtering, return raw stdout. The timeout is an
 * output-INACTIVITY window (stall guard), not a total-duration cap — a
 * long-but-streaming log completes; a hung spawn is reaped.
 */
export async function execFileForPathspec(repoRoot: string, args: string[], timeoutMs: number): Promise<string> {
  return execWithStallGuard(resolveGitExecutable(), args, {
    cwd: repoRoot,
    stallTimeoutMs: Math.max(timeoutMs, BULK_LOG_STALL_FLOOR_MS),
  });
}

/** Build CLI args for `git log --numstat`. Uses HEAD (not --all), no --max-count. */
export function buildCliArgs(sinceDate?: Date): string[] {
  const args = ["log", "HEAD", "--numstat", "--format=%x00%H%x00%P%x00%aN%x00%aE%x00%at%x00%B%x00"];
  if (sinceDate) {
    args.push(`--since=${sinceDate.toISOString()}`);
  }
  return args;
}

/** Resolve HEAD SHA via CLI `git rev-parse HEAD`. */
export async function getHead(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(resolveGitExecutable(), ["rev-parse", "HEAD"], { cwd: repoRoot });
  return stdout.trim();
}

/** Resolve git repo root from a path. Returns absolutePath if not a git repo. */
export function resolveRepoRoot(absolutePath: string): string {
  try {
    return execFileSync(resolveGitExecutable(), ["rev-parse", "--show-toplevel"], {
      cwd: absolutePath,
      encoding: "utf-8",
      env: buildGitChildProcessEnv(),
    }).trim();
  } catch {
    return absolutePath;
  }
}

/**
 * Run CLI `git log --numstat` and parse output into FileChurnData map.
 *
 * `timeoutMs` is an output-INACTIVITY window (stall guard), not a total cap:
 * the UNBOUNDED (no --since) full-history sweep on a large monolith streams
 * for minutes (taxdome: 104MB / 122.9s) and used to get SIGTERM'd at the 60s
 * execFile budget — failing the whole git enrichment while the spawn was
 * perfectly alive (tea-rags-mcp-w2dlu).
 */
export async function buildViaCli(
  repoRoot: string,
  sinceDate?: Date,
  timeoutMs?: number,
): Promise<Map<string, FileChurnData>> {
  const args = buildCliArgs(sinceDate);
  const stdout = await execWithStallGuard(resolveGitExecutable(), args, {
    cwd: repoRoot,
    stallTimeoutMs: Math.max(timeoutMs ?? 60_000, BULK_LOG_STALL_FLOOR_MS),
  });
  return parseNumstatOutput(stdout);
}

/**
 * Fetch file-level metadata for specific files (no --since filter).
 * Used as a backfill for files that weren't in the main git log window.
 * Batches file paths to stay within OS ARG_MAX limits.
 */
export async function buildViaCliForPaths(
  repoRoot: string,
  paths: string[],
  timeoutMs = 30000,
): Promise<Map<string, FileChurnData>> {
  if (paths.length === 0) return new Map();

  const result = new Map<string, FileChurnData>();
  const BATCH = 500; // stay within ARG_MAX

  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const args = ["log", "HEAD", "--numstat", "--format=%x00%H%x00%P%x00%aN%x00%aE%x00%at%x00%B%x00", "--", ...batch];

    try {
      const { stdout } = await execFileAsync(resolveGitExecutable(), args, {
        cwd: repoRoot,
        maxBuffer: Infinity,
        timeout: timeoutMs,
      });
      const batchResult = parseNumstatOutput(stdout);
      for (const [path, data] of batchResult) {
        result.set(path, data);
      }
    } catch (error) {
      if (isDebug()) {
        console.error(`[GitLogReader] Backfill batch failed:`, error instanceof Error ? error.message : error);
      }
    }
  }

  return result;
}
// ── Pathspec CLI operations ──────────────────────────────────────

const PATHSPEC_BATCH_SIZE = 500;

/**
 * NUL-delimited log format shared by the numstat log variants below.
 *
 * Every log format in this file reads the author as `%aN` / `%aE` — name and
 * email AFTER the repo's `.mailmap` — never the raw `%an` / `%ae`, so one
 * person committing under several identities is one author to the git
 * trajectory (bd tea-rags-mcp-nsxzh). `git blame --porcelain` applies the
 * mailmap to `author` / `author-mail` on its own (no flag), so `blameFile`
 * agrees with the log readers.
 */
const NUMSTAT_LOG_FORMAT = "--format=%x00%H%x00%P%x00%aN%x00%aE%x00%at%x00%B%x00";

/**
 * NUL-delimited log format for `readCommitFileNumstat` ONLY — inserts the
 * COMMITTER epoch (`%ct`) between the author epoch (`%at`) and the body (`%B`).
 * The file-churn discovery windows/evicts/sorts by committer date to match
 * `git log --since` (which filters on committer date), while `commit.timestamp`
 * (`%at`, author date) still feeds signal VALUES. The shared
 * `NUMSTAT_LOG_FORMAT` above is deliberately left untouched so the chunk path
 * (parseNumstatOutput / parsePathspecOutput) stays byte-identical.
 */
const NUMSTAT_LOG_FORMAT_WITH_COMMITTER = "--format=%x00%H%x00%P%x00%aN%x00%aE%x00%at%x00%ct%x00%B%x00";

/**
 * Repo-wide `git log --since --numstat` — NO pathspec, NO explicit rev
 * (defaults to HEAD, matching getCommitsByPathspecSingle). ONE such call per
 * indexing run replaces the K per-batch pathspec logs: the parsed
 * commit → changedFiles matrix is a superset of every pathspec slice, and the
 * chunk-churn walk already filters changedFiles against its chunk map
 * (bd tea-rags-mcp-82va1).
 */
export async function getCommitsSince(
  repoRoot: string,
  sinceDate: Date,
  timeoutMs?: number,
): Promise<CommitWithChangedFiles[]> {
  const effectiveTimeoutMs = timeoutMs ?? 30000;
  const args = ["log", `--since=${sinceDate.toISOString()}`, NUMSTAT_LOG_FORMAT, "--numstat"];
  const stdout = await execFileForPathspec(repoRoot, args, effectiveTimeoutMs);
  return parsePathspecOutput(stdout);
}

/**
 * `git log --since <fromSha>..<toSha> --numstat` — the incremental top-up for
 * a persisted commit-discovery matrix: only commits reachable from the new
 * HEAD but not from the persisted one (bd tea-rags-mcp-82va1).
 */
export async function getCommitsInRange(
  repoRoot: string,
  fromSha: string,
  toSha: string,
  sinceDate: Date,
  timeoutMs?: number,
): Promise<CommitWithChangedFiles[]> {
  const effectiveTimeoutMs = timeoutMs ?? 30000;
  const args = ["log", `--since=${sinceDate.toISOString()}`, `${fromSha}..${toSha}`, NUMSTAT_LOG_FORMAT, "--numstat"];
  const stdout = await execFileForPathspec(repoRoot, args, effectiveTimeoutMs);
  return parsePathspecOutput(stdout);
}

/**
 * `git log [--since] [fromSha..toSha] --numstat` — the numstat-PRESERVING
 * sibling of `getCommitsSince`/`getCommitsInRange`: same NUL-delimited log
 * format and stall-guarded exec, but keeps each file's +/- counts instead of
 * collapsing them into `changedFiles: string[]`. `range` present narrows to
 * `fromSha..toSha` (incremental top-up, excludes `fromSha`'s own contribution
 * same as `getCommitsInRange`); absent walks the whole `--since` window.
 */
export async function readCommitFileNumstat(
  repoRoot: string,
  sinceDate?: Date,
  range?: { fromSha: string; toSha: string },
  timeoutMs?: number,
): Promise<CommitFileNumstat[]> {
  const effectiveTimeoutMs = timeoutMs ?? 30000;
  const args = ["log"];
  if (sinceDate) args.push(`--since=${sinceDate.toISOString()}`);
  if (range) args.push(`${range.fromSha}..${range.toSha}`);
  args.push(NUMSTAT_LOG_FORMAT_WITH_COMMITTER, "--numstat");
  const stdout = await execFileForPathspec(repoRoot, args, effectiveTimeoutMs);
  return parseCommitFileNumstat(stdout);
}

/** The HEAD commit's committer time, unix seconds. Rejects on a repository with no commit. */
export async function readHeadCommitTime(repoRoot: string, timeoutMs = TREE_LISTING_STALL_MS): Promise<number> {
  return readCommitTime(repoRoot, "HEAD", timeoutMs);
}

/**
 * A commit's committer time, unix seconds — `git log -1 --format=%ct <rev>`.
 * Rejects when the repository does not hold `rev` (bd tea-rags-mcp-zwu7m: the
 * query clock of a head-anchored index is its INDEXED commit's time, and that
 * commit may have been garbage-collected since).
 */
export async function readCommitTime(
  repoRoot: string,
  rev: string,
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<number> {
  const out = await execWithStallGuard(resolveGitExecutable(), ["log", "-1", "--format=%ct", rev], {
    cwd: repoRoot,
    stallTimeoutMs: timeoutMs,
  });
  const seconds = Number(out.trim());
  if (out.trim() === "" || !Number.isFinite(seconds)) throw new Error(`no commit time for ${rev} in ${repoRoot}`);
  return seconds;
}

/**
 * `git log HEAD -M --name-status` over the WHOLE history — every commit's
 * changed paths with no line counts (bd tea-rags-mcp-i6tkc). Skipping the
 * per-blob diff a numstat computes is what makes it cheap: on the tea-rags
 * repository (5.1k commits) it reads in ~0.3 s against ~1.9 s for the same
 * walk with `--numstat`. `-M` pins rename detection whatever `diff.renames`
 * says, so a rename always arrives paired.
 */
export async function readCommitPathChanges(repoRoot: string, timeoutMs?: number): Promise<CommitPathChanges[]> {
  const args = ["log", "HEAD", "-z", "-M", "--name-status", `--format=${COMMIT_PATH_CHANGES_HEADER}%H %at`];
  return parseCommitPathChanges(await execFileForPathspec(repoRoot, args, timeoutMs ?? 30000));
}

/**
 * `git log HEAD --numstat -- <paths>` kept per commit, with the rename rows a
 * pathspec hides put back (bd tea-rags-mcp-aikfk).
 *
 * Git detects a rename only between paths the pathspec names, so a commit that
 * moved a named path in from an unnamed one prints a plain add, and one that
 * moved it out prints a plain delete — neither row carries `previousPath`, and
 * a caller following renames (`sliceCommitsFollowingRenames`) never learns the
 * predecessor. `--diff-filter=AD` lists exactly those commits; they are re-read
 * without the pathspec (`--no-walk`, one spawn) and their rows touching a named
 * path on either side replace the pathspec-limited ones. Commits that only
 * modified a named path keep their pathspec rows. Log order is preserved.
 *
 * `since` present bounds both logs with `--since` and walks them with
 * `--full-history`: the pathspec-limited form of a repo-wide `git log --since
 * --numstat` (the run-scoped discovery an index run reads), whose commits a
 * pathspec log would otherwise simplify away wherever a merge is TREESAME to
 * one parent for the path (bd tea-rags-mcp-xi2r9).
 */
export async function readCommitFileNumstatForPaths(
  repoRoot: string,
  paths: string[],
  timeoutMs?: number,
  since?: Date,
): Promise<CommitFileNumstat[]> {
  if (paths.length === 0) return [];
  const effectiveTimeoutMs = timeoutMs ?? 30000;
  const window = since ? [`--since=${since.toISOString()}`, "--full-history"] : [];
  const entries = parseCommitFileNumstat(
    await execFileForPathspec(
      repoRoot,
      ["log", "HEAD", ...window, "--numstat", NUMSTAT_LOG_FORMAT_WITH_COMMITTER, "--", ...paths],
      effectiveTimeoutMs,
    ),
  );
  const addOrDelete = (
    await execFileForPathspec(
      repoRoot,
      ["log", "HEAD", ...window, "--diff-filter=AD", "--format=%H", "--", ...paths],
      effectiveTimeoutMs,
    )
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (addOrDelete.length === 0) return entries;

  const named = new Set(paths);
  const unrestricted = new Map(
    parseCommitFileNumstat(
      await execFileForPathspec(
        repoRoot,
        ["log", "--no-walk=unsorted", NUMSTAT_LOG_FORMAT_WITH_COMMITTER, "--numstat", ...addOrDelete],
        effectiveTimeoutMs,
      ),
    ).map((entry) => [entry.commit.sha, entry]),
  );
  return entries.map((entry) => {
    const full = unrestricted.get(entry.commit.sha);
    if (!full) return entry;
    const files = full.files.filter(
      (row) => named.has(row.path) || (row.previousPath !== undefined && named.has(row.previousPath)),
    );
    return files.length > 0 ? { ...entry, files } : entry;
  });
}

/**
 * True iff `ancestor` is an ancestor of `descendant` per
 * `git merge-base --is-ancestor`. Any failure — non-ancestor exit code,
 * unresolvable / gc'd shas, not a repo — resolves false, which callers treat
 * as "cannot top up, rebuild fully" (bd tea-rags-mcp-82va1).
 */
export async function isAncestor(repoRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync(resolveGitExecutable(), ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The best common ancestor of `ref` and HEAD (`git merge-base <ref> HEAD`) —
 * where a branch left `ref`, so a diff against it holds only the branch's
 * side (three-dot semantics). `null` when the two share no history: unrelated
 * roots, or a shallow clone whose cut-off hides the ancestor. An unknown ref or
 * a path outside a repository rejects.
 */
export async function readMergeBase(repoRoot: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(resolveGitExecutable(), ["merge-base", ref, "HEAD"], { cwd: repoRoot });
    return stdout.trim();
  } catch (error) {
    // Exit 1 is git's "no common ancestor"; an unknown ref or a non-repository exits 128.
    if ((error as { code?: unknown }).code === 1) return null;
    throw error;
  }
}

/**
 * The commits HEAD has that `base` does not (`git rev-list <base>..HEAD`),
 * newest first — a review's own commits when `base` is its merge-base. Empty
 * when HEAD is `base`. An unknown commit or a path outside a repository rejects.
 */
export async function listCommitsSince(repoRoot: string, base: string): Promise<string[]> {
  const { stdout } = await execFileAsync(resolveGitExecutable(), ["rev-list", `${base}..HEAD`], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\n").filter((line) => line.length > 0);
}

/**
 * The commits on either side of `sinceCommit...headCommit` that touched each
 * path, repo-relative, newest first (`--no-renames`: a committed move lists
 * both its sides under its commit).
 */
export interface PathCommitsSince {
  /** Commits reachable from HEAD and not from the stamp (`since..head`) — what HEAD's history adds. */
  headSide: ReadonlyMap<string, readonly string[]>;
  /**
   * Commits reachable from the stamp and not from HEAD — what HEAD's history
   * lacks. Empty when HEAD descends from the stamp.
   */
  stampSide: ReadonlyMap<string, readonly string[]>;
}

const COMMIT_HEADER_MARK = "\u0001";

/**
 * Which commits on either side of the stamp touched which paths — one spawn for
 * the whole symmetric range (`git log --left-right since...head`). The
 * working-tree overlay's answer to "whose history moved since the index" (live
 * G1) and to "which commits does a path's history at HEAD hold that the stamp's
 * does not" (live C2: a path's on-demand git signals are keyed by exactly
 * that, so a commit touching one file leaves every other file's record valid).
 * bd tea-rags-mcp-xi2r9. An unknown commit or a path outside a repository rejects.
 */
export async function readPathCommitsSince(
  repoRoot: string,
  sinceCommit: string,
  headCommit: string,
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<PathCommitsSince> {
  const out = await execWithStallGuard(
    resolveGitExecutable(),
    [
      "log",
      "-z",
      `--format=${COMMIT_HEADER_MARK}%m%H`,
      "--name-only",
      "--no-renames",
      "--left-right",
      `${sinceCommit}...${headCommit}`,
      "--",
    ],
    { cwd: repoRoot, stallTimeoutMs: timeoutMs },
  );
  const headSide = new Map<string, string[]>();
  const stampSide = new Map<string, string[]>();
  let commit: { sha: string; side: Map<string, string[]> } | undefined;
  for (const token of splitNulTerminated(out)) {
    const entry = token.replace(/^\n+/, "");
    if (entry === "") continue;
    if (entry.startsWith(COMMIT_HEADER_MARK)) {
      const side = entry.charAt(1) === "<" ? stampSide : headSide;
      commit = { sha: entry.slice(2), side };
      continue;
    }
    if (!commit) continue;
    const shas = commit.side.get(entry);
    if (shas) shas.push(commit.sha);
    else commit.side.set(entry, [commit.sha]);
  }
  return { headSide, stampSide };
}

/** Run a single pathspec-filtered git log and parse the output. */
export async function getCommitsByPathspecSingle(
  repoRoot: string,
  sinceDate: Date,
  filePaths: string[],
  timeoutMs?: number,
): Promise<CommitWithChangedFiles[]> {
  const effectiveTimeoutMs = timeoutMs ?? 30000;
  const args = [
    "log",
    `--since=${sinceDate.toISOString()}`,
    "--format=%x00%H%x00%P%x00%aN%x00%aE%x00%at%x00%B%x00",
    "--numstat",
    "--",
    ...filePaths,
  ];

  const stdout = await execFileForPathspec(repoRoot, args, effectiveTimeoutMs);
  return parsePathspecOutput(stdout);
}

/**
 * Run multiple pathspec CLI calls in batches, merge results by commit SHA.
 * Same commit may appear in multiple batches (touched files in different batches).
 */
export async function getCommitsByPathspecBatched(
  repoRoot: string,
  sinceDate: Date,
  filePaths: string[],
  timeoutMs?: number,
): Promise<CommitWithChangedFiles[]> {
  const batchSize = PATHSPEC_BATCH_SIZE;
  const batches: string[][] = [];
  for (let i = 0; i < filePaths.length; i += batchSize) {
    batches.push(filePaths.slice(i, i + batchSize));
  }

  if (isDebug()) {
    console.error(
      `[ChunkChurn] Pathspec batching: ${filePaths.length} files → ${batches.length} batches of ≤${batchSize}`,
    );
  }

  // Deduped by CURRENT path: the same file can surface in several batches, and
  // its rename pair is identical every time it does (the pair is a property of
  // the commit, not of the batch) — so first writer wins.
  const merged = new Map<string, { commit: CommitInfo; changedFiles: Map<string, CommitChangedPath> }>();

  for (const batch of batches) {
    try {
      const batchResult = await getCommitsByPathspecSingle(repoRoot, sinceDate, batch, timeoutMs);
      for (const entry of batchResult) {
        const existing = merged.get(entry.commit.sha);
        const target = existing?.changedFiles ?? new Map<string, CommitChangedPath>();
        for (const changed of entry.changedFiles) {
          if (!target.has(changed.path)) target.set(changed.path, changed);
        }
        if (!existing) merged.set(entry.commit.sha, { commit: entry.commit, changedFiles: target });
      }
    } catch (error) {
      if (isDebug()) {
        console.error(
          `[ChunkChurn] Pathspec batch failed (${batch.length} files):`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  return Array.from(merged.values()).map(({ commit, changedFiles }) => ({
    commit,
    changedFiles: Array.from(changedFiles.values()),
  }));
}

/**
 * Get commits touching specific files via CLI pathspec filtering.
 * Dispatches to single or batched depending on count.
 */
export async function getCommitsByPathspec(
  repoRoot: string,
  sinceDate: Date,
  filePaths: string[],
  timeoutMs?: number,
): Promise<CommitWithChangedFiles[]> {
  if (filePaths.length === 0) return [];

  if (filePaths.length > PATHSPEC_BATCH_SIZE) {
    return getCommitsByPathspecBatched(repoRoot, sinceDate, filePaths, timeoutMs);
  }

  return getCommitsByPathspecSingle(repoRoot, sinceDate, filePaths, timeoutMs);
}

// ── Blame primitive ──────────────────────────────────────────────

/**
 * Run `git blame --porcelain HEAD -- <file>` and return per-line attributions.
 * Returns an empty array when the file is untracked, missing, or the command
 * fails — callers treat absence of blame data as "no ownership signal", not as
 * an error condition.
 */
export async function blameFile(repoRoot: string, filePath: string, timeoutMs?: number): Promise<BlameLine[]> {
  try {
    const { stdout } = await execFileAsync(resolveGitExecutable(), ["blame", "--porcelain", "HEAD", "--", filePath], {
      cwd: repoRoot,
      maxBuffer: Infinity,
      timeout: timeoutMs,
    });
    return parseBlameOutput(stdout);
  } catch {
    return [];
  }
}

/**
 * One-time pre-enrichment warmup: `git commit-graph write --reachable
 * --changed-paths`. The commit-graph gives O(1) generation-number reachability
 * (accelerates every `git log`) and the `--changed-paths` Bloom filters
 * accelerate pathspec `git log` AND `git blame` — a free speedup for the whole
 * enrichment sweep regardless of adapter. Best-effort: any failure (no repo
 * write access, concurrent gc lock, old git) is swallowed — the graph is a pure
 * optimization, never a correctness dependency. Persists on disk, so subsequent
 * runs (and incremental reindexes) reuse it.
 */
export async function writeCommitGraph(repoRoot: string, timeoutMs?: number): Promise<void> {
  try {
    await execFileAsync(resolveGitExecutable(), ["commit-graph", "write", "--reachable", "--changed-paths"], {
      cwd: repoRoot,
      timeout: timeoutMs,
    });
  } catch {
    // Optimization only — proceed without it.
  }
}
