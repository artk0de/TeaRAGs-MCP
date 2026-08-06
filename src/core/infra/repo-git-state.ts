/**
 * RepoGitState — file-based reader of a repository's git state.
 *
 * bd tea-rags-mcp-sog3a (hpg2 auto-update watcher): the freshness verdict and
 * the pipeline-finalize registry write both need "which branch/commit is this
 * working tree on, and is it mid-rebase" — cheaply enough to run on every MCP
 * tool call (~1 ms budget), so HEAD/refs are read straight from `.git` files
 * with no git spawn. Only `readWorkingTreeDirty` shells out (pipeline-finalize
 * use only, never on the trigger path).
 *
 * Stays in `infra` on purpose: TWO domains consume it — the ingest pipeline
 * (finalize-time `RegistryGitState` write in `pipeline/base.ts`) and the
 * maintenance freshness check (`domains/maintenance/freshness/`). Moving it
 * into either one would create a `domains <-> domains` edge, so the foundation
 * is the only legal home (same rationale as `commit-diff-memo.ts`).
 *
 * Worktree layout is handled: `.git` may be a FILE (`gitdir: <path>`) pointing
 * at the per-worktree gitdir, whose `commondir` file locates the shared refs.
 * HEAD / MERGE_HEAD / rebase state are per-worktree; refs and packed-refs are
 * common.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface RepoGitState {
  /** Branch checked out; null = detached HEAD (or a non-branch ref). */
  branch: string | null;
  /** Resolved HEAD sha; "" when the ref exists but has no commit yet (unborn). */
  commit: string;
  /** A rebase / merge / bisect is in progress — auto-update must not fire. */
  transient: boolean;
}

interface ResolvedGitDirs {
  /** Per-worktree gitdir: HEAD, MERGE_HEAD, rebase-merge/ live here. */
  gitdir: string;
  /** Shared dir: refs/ and packed-refs live here (== gitdir for a main checkout). */
  commondir: string;
}

const TRANSIENT_MARKERS = ["MERGE_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"];

function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function resolveGitDirs(repoPath: string): ResolvedGitDirs | null {
  const dotGit = join(repoPath, ".git");
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    return { gitdir: dotGit, commondir: dotGit };
  }
  // Worktree: `.git` is a file containing `gitdir: <path>`.
  const content = readTextIfExists(dotGit);
  const match = content?.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match?.[1]) return null;
  const gitdir = isAbsolute(match[1]) ? match[1] : resolve(repoPath, match[1]);
  const commondirRel = readTextIfExists(join(gitdir, "commondir"))?.trim();
  const commondir = commondirRel !== undefined && commondirRel.length > 0 ? resolve(gitdir, commondirRel) : gitdir;
  return { gitdir, commondir };
}

/** Resolve `refs/heads/<x>` to a sha via loose ref file, then packed-refs. */
function resolveRef(ref: string, commondir: string): string {
  const loose = readTextIfExists(join(commondir, ref))?.trim();
  if (loose !== undefined && loose.length > 0) return loose;
  const packed = readTextIfExists(join(commondir, "packed-refs"));
  if (packed !== null) {
    for (const line of packed.split("\n")) {
      if (line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha !== undefined) return sha;
    }
  }
  return "";
}

/**
 * Fast, file-based git state read — no git spawn. Returns null when
 * `repoPath` is not a git repository or its `.git` state is unreadable.
 * Never throws: this runs on every freshness trigger check.
 */
export function readRepoGitState(repoPath: string): RepoGitState | null {
  try {
    const dirs = resolveGitDirs(repoPath);
    if (dirs === null) return null;
    const head = readTextIfExists(join(dirs.gitdir, "HEAD"))?.trim();
    if (head === undefined || head.length === 0) return null;

    const transient = TRANSIENT_MARKERS.some((marker) => existsSync(join(dirs.gitdir, marker)));

    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (refMatch?.[1] !== undefined) {
      const ref = refMatch[1].trim();
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
      return { branch, commit: resolveRef(ref, dirs.commondir), transient };
    }
    // Detached HEAD: the file carries the sha itself.
    return { branch: null, commit: head, transient };
  } catch {
    return null;
  }
}

/**
 * Whether the working tree has uncommitted changes (tracked files only).
 * Spawns `git status --porcelain -uno` — pipeline-finalize use only, NOT the
 * trigger path. Conservative: any failure (git missing, timeout) reads as
 * clean so it never blocks an indexing run's finalize.
 */
export function readWorkingTreeDirty(repoPath: string, execFileImpl: typeof execFileSync = execFileSync): boolean {
  try {
    const out = execFileImpl("git", ["-C", repoPath, "status", "--porcelain", "-uno"], {
      timeout: 15_000,
      encoding: "utf-8",
    });
    return String(out).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Default-branch autodetect for `tea-rags auto-update enable`:
 * `origin/HEAD` symref first, then an existing local `main` / `master` ref,
 * finally the literal "main".
 */
export function detectDefaultBranch(repoPath: string, execFileImpl: typeof execFileSync = execFileSync): string {
  try {
    const out = String(
      execFileImpl("git", ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        timeout: 15_000,
        encoding: "utf-8",
      }),
    ).trim();
    if (out.length > 0) return out.startsWith("origin/") ? out.slice("origin/".length) : out;
  } catch {
    // No origin/HEAD — fall through to local ref probing.
  }
  const dirs = resolveGitDirs(repoPath);
  if (dirs !== null) {
    for (const candidate of ["main", "master"]) {
      if (resolveRef(`refs/heads/${candidate}`, dirs.commondir).length > 0) return candidate;
    }
  }
  return "main";
}
