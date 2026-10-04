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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { buildGitChildProcessEnv, resolveGitExecutable } from "./git-executable.js";

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
 * clean so it never blocks an indexing run's finalize. Runs with git's optional
 * locks off, so the read never takes `index.lock` in the user's tree (bd
 * tea-rags-mcp-s5kpv).
 */
export function readWorkingTreeDirty(repoPath: string, execFileImpl: typeof execFileSync = execFileSync): boolean {
  try {
    const out = execFileImpl(resolveGitExecutable(), ["-C", repoPath, "status", "--porcelain", "-uno"], {
      timeout: 15_000,
      encoding: "utf-8",
      env: buildGitChildProcessEnv(),
    });
    return String(out).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Nearest ancestor of `absolutePath` (inclusive) holding `.git` — the git
 * toplevel of the tree the path lies in. Filesystem only, no realpath: callers
 * hand over the spelling they compare against. A linked worktree and a
 * submodule hold a `.git` FILE, so `existsSync` covers every layout.
 *
 * Why it exists: a project may be registered at a SUBDIRECTORY of its
 * repository, and every reader that expects `.git` at the project root
 * (`readRepoGitState`) then sees no repository at all (live P2-2, bd
 * tea-rags-mcp-xi2r9).
 */
export function findGitToplevel(absolutePath: string): string | undefined {
  let dir = absolutePath;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * `readRepoGitState` of the repository `path` lies in — read at its git
 * toplevel, so a project registered at a repository SUBDIRECTORY (no `.git` at
 * its root) still reads HEAD (live P2-2, bd tea-rags-mcp-xi2r9). Same
 * never-throws, no-spawn contract.
 */
export function readEnclosingRepoGitState(path: string): RepoGitState | null {
  return readRepoGitState(findGitToplevel(path) ?? path);
}

/**
 * Where `rootPath` sits below its git toplevel, "/"-separated as git spells
 * paths; "" when the root IS the toplevel. The prefix the two re-base helpers
 * below take.
 */
export function gitPathPrefix(toplevel: string, rootPath: string): string {
  return relative(toplevel, rootPath).split(sep).join("/");
}

/**
 * Toplevel-relative git paths → the ones under `prefix`, relative to the root.
 * Git reports every path from the toplevel; a project registered below it
 * names its files from its own root, and a sibling directory's path is not the
 * project's at all, so it is dropped.
 */
export function rebaseGitPathsOntoRoot(paths: readonly string[], prefix: string): string[] {
  if (prefix === "") return [...paths];
  const head = `${prefix}/`;
  return paths.filter((path) => path.startsWith(head)).map((path) => path.slice(head.length));
}

/** A root-relative path → the toplevel-relative spelling git expects. Inverse of {@link rebaseGitPathsOntoRoot}. */
export function gitPathFromRoot(rootRelativePath: string, prefix: string): string {
  return prefix === "" ? rootRelativePath : `${prefix}/${rootRelativePath}`;
}

/**
 * The files under `rootPath` whose content differs from HEAD — modified,
 * staged, deleted and untracked non-ignored — relative to `rootPath` (not to
 * the git toplevel, which git reports from). Undefined when git cannot answer.
 *
 * Why: an index run reads the tree, not the commit, so a file dirty at index
 * time is indexed with content its `indexedCommit` does not hold. A later diff
 * against that commit cannot see it once the file is restored (or deleted, for
 * an untracked one), so the run stamps this list and the working-tree overlay
 * re-reads those files (live P1-1, bd tea-rags-mcp-xi2r9). Spawns
 * `git status` — pipeline-finalize use only. `--no-renames` lists both sides of
 * a move, which is what "differs from HEAD" means per path.
 */
export function readWorkingTreeDirtyPaths(
  rootPath: string,
  execFileImpl: typeof execFileSync = execFileSync,
): string[] | undefined {
  const toplevel = findGitToplevel(rootPath);
  if (toplevel === undefined) return undefined;
  let out: string;
  try {
    out = String(
      execFileImpl(
        resolveGitExecutable(),
        ["-C", toplevel, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
        // Optional locks off: no `index.lock` in the user's tree (bd tea-rags-mcp-s5kpv).
        { timeout: 15_000, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, env: buildGitChildProcessEnv() },
      ),
    );
  } catch {
    return undefined;
  }
  // "XY path" — porcelain paths are always toplevel-relative, "/"-separated.
  const toplevelPaths = out
    .split("\0")
    .filter((field) => field.length >= 4)
    .map((field) => field.slice(3));
  return rebaseGitPathsOntoRoot(toplevelPaths, gitPathPrefix(toplevel, rootPath));
}

/**
 * Default-branch autodetect for `tea-rags auto-update enable`:
 * `origin/HEAD` symref first, then an existing local `main` / `master` ref,
 * finally the literal "main".
 */
export function detectDefaultBranch(repoPath: string, execFileImpl: typeof execFileSync = execFileSync): string {
  try {
    const out = String(
      execFileImpl(resolveGitExecutable(), ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        timeout: 15_000,
        encoding: "utf-8",
        env: buildGitChildProcessEnv(),
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
