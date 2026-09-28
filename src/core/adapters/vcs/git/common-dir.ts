/**
 * Repo identity — the shared git directory behind a working tree.
 *
 * A linked worktree and its main checkout are two working trees over ONE object
 * database, so anything keyed per-repository (the blame cache, the discovery
 * matrices, inherited index config) must key by this, not by the working tree.
 *
 * Resolved from the filesystem rather than `git rev-parse --git-common-dir`,
 * deliberately: this sits on the cache-lookup path, git process spawns are the
 * scarce resource there (machine-wide endpoint scanning throttles them), and a
 * module that shells out drags `node:child_process` into every consumer of the
 * public API barrel. The layout read here is git's own:
 *
 *   plain checkout   <tree>/.git                 is a directory → that IS it
 *   linked worktree  <tree>/.git                 is a file: "gitdir: <admin>"
 *                    <admin>/commondir           relative path to the shared dir
 *
 * Anything unrecognised (not a repo, unreadable, exotic layout) falls back to
 * the path itself, which keeps callers at their old per-path behaviour.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const GITDIR_PREFIX = "gitdir:";

/** Shared git dir for `absolutePath`; the path itself when it cannot be read. */
export function resolveGitCommonDir(absolutePath: string): string {
  try {
    const dotGit = join(realpathSync(absolutePath), ".git");
    if (statSync(dotGit).isDirectory()) return dotGit;

    // Linked worktree: `.git` is a file pointing at this tree's admin dir,
    // whose `commondir` names the shared one (normally `../..`).
    const pointer = readFileSync(dotGit, "utf8").trim();
    if (!pointer.startsWith(GITDIR_PREFIX)) return absolutePath;
    const adminDir = pointer.slice(GITDIR_PREFIX.length).trim();
    const absoluteAdminDir = isAbsolute(adminDir) ? adminDir : resolve(absolutePath, adminDir);

    const commonDir = readFileSync(join(absoluteAdminDir, "commondir"), "utf8").trim();
    return realpathSync(resolve(absoluteAdminDir, commonDir));
  } catch {
    return absolutePath;
  }
}

/**
 * Every working tree of the repository behind `absolutePath`, realpath'd: the
 * main checkout (when the shared dir is its `.git`) and each linked worktree
 * git registered under `<common>/worktrees/<name>/gitdir`. Read from the
 * filesystem for the reason {@link resolveGitCommonDir} is; an unreadable
 * layout yields what could be read, never throws.
 */
export function listRepoWorkTrees(absolutePath: string): string[] {
  const commonDir = resolveGitCommonDir(absolutePath);
  const trees: string[] = [];
  if (basename(commonDir) === ".git") trees.push(dirname(commonDir));
  for (const admin of readWorkTreeAdminDirs(commonDir)) {
    try {
      const dotGit = readFileSync(join(commonDir, "worktrees", admin, "gitdir"), "utf8").trim();
      const tree = dirname(dotGit);
      if (existsSync(tree)) trees.push(realpathSync(tree));
    } catch {
      // A half-removed worktree has no gitdir: nothing to list.
    }
  }
  return [...new Set(trees)].sort();
}

/** The linked worktrees' admin dir names under `<common>/worktrees`; none when the repo has no linked worktree. */
function readWorkTreeAdminDirs(commonDir: string): string[] {
  try {
    return readdirSync(join(commonDir, "worktrees"));
  } catch {
    return [];
  }
}
