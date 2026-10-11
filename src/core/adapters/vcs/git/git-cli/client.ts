/**
 * Low-level git repo queries — CLI only. No enrichment concepts, no caching.
 *
 * HEAD and repo-root resolution, commit times, ancestry, merge base, and the
 * commit-graph warmup. History walks live in `history.ts`, object reads in
 * `cat-file.ts`, working-tree reads in `working-tree.ts`, exec primitives in
 * `exec.ts`.
 *
 * Everything goes through the git CLI. isomorphic-git was removed: its pack
 * reader loaded the ENTIRE packfile into a JS ArrayBuffer (heap profiler caught
 * 3×1.4 GB on a large repo → 16 GB OOM). `git cat-file` / `git rev-parse`
 * stream individual objects from disk, so resident memory never includes the
 * whole pack.
 */
import { execFileSync } from "node:child_process";

import { buildGitChildProcessEnv, resolveGitExecutable } from "../git-executable.js";
import { readRepoGitState } from "../repo-git-state.js";
import { execFileAsync, TREE_LISTING_STALL_MS } from "./exec.js";
import { execWithStallGuard } from "./stall-guard-exec.js";

/** Environment variables that move where git finds the repository — present, only git knows HEAD. */
const GIT_REPOSITORY_REDIRECTING_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"] as const;

/** A full object name, SHA-1 or SHA-256 — what `git rev-parse HEAD` prints. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Resolve HEAD's SHA. Read from the repository's own files when they answer it
 * (bd tea-rags-mcp-0qaht.51): `HEAD`, the loose ref or `packed-refs` line it
 * names, a linked worktree's per-worktree gitdir — the same commit
 * `git rev-parse HEAD` prints, without the child an endpoint-security agent
 * makes cost hundreds of milliseconds per read. Git is still asked when the
 * environment redirects it (`GIT_DIR`, …), `repoRoot` holds no `.git` of its
 * own (a subdirectory), or the files name no object (an unborn branch, a ref
 * format the reader does not know) — so every failure stays git's.
 */
export async function getHead(repoRoot: string): Promise<string> {
  if (!GIT_REPOSITORY_REDIRECTING_ENV.some((name) => process.env[name])) {
    const commit = readRepoGitState(repoRoot)?.commit;
    if (commit !== undefined && OBJECT_NAME.test(commit)) return commit;
  }
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
