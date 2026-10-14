/**
 * The shared diff-scope reader (bd tea-rags-mcp-89k7k.1.1): one read of a
 * working-tree change — every changed file, its added line ranges, the
 * merge-base the change is read against, and the bookkeeping (notices, counts,
 * the non-production files) every diff-scoped report consumes. The review sections of
 * `get_naming_lexicon` are its first consumer; the naming-specific half
 * (per-file declaration extraction) stayed behind in `naming-lexicon-ops.ts`.
 *
 * Pure functions on purpose: the read holds no state worth a class, so the
 * next diff-scoped report calls it without a deps interface.
 */

import { realpathSync } from "node:fs";

import {
  findGitToplevel,
  gitPathFromRoot,
  gitPathPrefix,
  listCommitsSince,
  listRepoWorkTrees,
  readAddedLineRangesOfFiles,
  readEnclosingRepoGitState,
  readMergeBase,
  readRenamedFrom,
  readWorkingTreeChanges,
  rebaseGitPathsOntoRoot,
  type AddedLineRange,
} from "../../../adapters/vcs/index.js";
import type { RegistryLookup } from "../../../contracts/types/registry.js";
import { InvalidParameterError } from "../../public/errors.js";
import { ontologyNonProductionPathFilter } from "./ontology-report-ops.js";

/** Diff mode's base when the request names none: the working tree against HEAD (spec §6). */
const DIFF_DEFAULT_BASE = "HEAD";
/** A listed file with no diff is reviewed whole — every line reads as added. */
const WHOLE_FILE: readonly AddedLineRange[] = [{ start: 1, end: Number.MAX_SAFE_INTEGER }];

/** Which change to read: the base to diff against, or an explicit list of files. */
export interface DiffScopeRequest {
  base?: string;
  files?: readonly string[];
}

/** One read of a working-tree change: the files, their added lines, and the counts a report opens with. */
export interface DiffScopeRead {
  /** The working tree the change was read from. */
  workTree: string;
  base: string;
  /** `base`'s merge-base with HEAD — what the change is read against. */
  mergeBase: string;
  /** Non-fatal observations — an empty diff is one, never a bare `changedFiles: 0`. */
  notices: readonly string[];
  /** Of the reviewed files, how many the change actually touched. */
  changedFiles: number;
  /** How many listed files had no diff and are read whole. */
  wholeFiles: number;
  /** Every reviewed file (listed or changed) — what evidence exclusion carries. */
  files: readonly string[];
  /**
   * Every path the change touches (bd tea-rags-mcp-lxbrr): the reviewed files
   * (listed or changed), every path changed against the merge-base (committed
   * range + working tree, untracked included) and every path it deleted. A
   * section asking "is this partner in the change?" asks this set — a deleted
   * partner, or a changed one a `files` list did not name, is in the change,
   * never missing.
   */
  touchedFiles: ReadonlySet<string>;
  /** Per reviewed file its added line ranges; a whole-file read is one range over every line. */
  addedRanges: ReadonlyMap<string, readonly AddedLineRange[]>;
  /** The read files the ontology's non-production masks cover — a report skips them, not judges them. */
  nonProduction: ReadonlySet<string>;
  /**
   * The change's own commits, `mergeBase..HEAD` (bd tea-rags-mcp-89k7k.1.14) —
   * a co-change test drops the history bundles they formed, so the change
   * cannot confirm itself. Absent on a scope read without git (a fixture).
   */
  diffCommits?: readonly string[];
  /**
   * The change's moves against the merge-base (bd tea-rags-mcp-89k7k.1.7): new
   * path -> old path, in the same path space as `files` / `touchedFiles`.
   * Absent when the change moved nothing.
   */
  renamedFrom?: ReadonlyMap<string, string>;
}

/** The evidence corpus's lag behind the tree an answer is about. */
export interface DiffTreeLag {
  indexedCommit: string;
  treeCommit: string;
}

/**
 * One read of a working-tree change (spec §6.1–6.3): the changed files against
 * the base resolved to its merge-base with HEAD (bd tea-rags-mcp-y33ee) —
 * `files` when given, else `git diff --name-only` plus untracked files — every
 * one of them, uncapped (bd tea-rags-mcp-89k7k.1.8: a review judges the whole
 * change); per file its added line ranges. A listed file
 * with no diff is read whole: on a clean tree `files` names committed code to
 * review, and an empty answer would read as "all conforms".
 *
 * Callers resolve the tree with `resolveWorkingTree` (`collection-resolver.ts`) — the
 * reader owns the whole diff-read contract: addressing splits in two layers,
 * git reads from the tree while index reads address the resolved collection
 * (bd tea-rags-mcp-2kplu), and the change is a three-dot diff against the
 * merge-base (bd tea-rags-mcp-y33ee).
 */
export async function readDiffScope(workTree: string | undefined, req: DiffScopeRequest): Promise<DiffScopeRead> {
  if (!workTree) {
    throw new InvalidParameterError("path", "changes / files review the working tree: pass project or path");
  }
  const base = req.base ?? DIFF_DEFAULT_BASE;
  // Git is asked at the toplevel and answers in toplevel-relative paths; the
  // review names files relative to `workTree`, which may be a repository
  // SUBDIRECTORY (live P2-2, bd tea-rags-mcp-xi2r9) — a sibling directory's
  // change is not this project's.
  const toplevel = findGitToplevel(workTree) ?? workTree;
  const prefix = gitPathPrefix(toplevel, workTree);
  // HEAD's commit from the repository's files, not a git child (bd
  // tea-rags-mcp-0qaht.63): every spawn costs hundreds of milliseconds when an
  // endpoint-security agent serializes them. Unknown ("" unborn, null not a
  // repository) → every read below goes to git as before.
  const headCommit = readEnclosingRepoGitState(toplevel)?.commit || undefined;
  const mergeBase = await resolveReviewMergeBase(toplevel, base, headCommit);
  const changes = await gitRead(base, async () => readWorkingTreeChanges(toplevel, mergeBase));
  const changed = rebaseGitPathsOntoRoot(changes.changed, prefix);
  const deleted = rebaseGitPathsOntoRoot(changes.deleted, prefix);
  const listed = req.files ? unique(req.files) : undefined;
  const files = listed ?? changed;
  const changedSet = new Set(changed);
  const nonProductionFilter = ontologyNonProductionPathFilter();
  // One git diff invocation reads every file's added-line ranges.
  const ranges = await gitRead(base, async () =>
    readAddedLineRangesOfFiles(
      toplevel,
      mergeBase,
      files.map((relPath) => gitPathFromRoot(relPath, prefix)),
      undefined,
      // The change's own untracked listing — the same whole-tree read, not a second spawn.
      changes.untracked,
    ),
  );
  const whole = new Set(listed ? files.filter((relPath) => !changedSet.has(relPath)) : []);
  const addedRanges = new Map<string, readonly AddedLineRange[]>(
    files.map((relPath) => [
      relPath,
      whole.has(relPath) ? WHOLE_FILE : (ranges.get(gitPathFromRoot(relPath, prefix)) ?? []),
    ]),
  );

  const nonProduction = new Set(files.filter((relPath) => nonProductionFilter.ignores(relPath)));
  // `HEAD..HEAD` is empty: a merge-base at HEAD has no commits of its own to list.
  const diffCommits =
    mergeBase === headCommit ? [] : await gitRead(base, async () => listCommitsSince(toplevel, mergeBase));
  const renamedFrom = await gitRead(base, async () =>
    readRenamedFrom(toplevel, prefix, mergeBase, changes.untracked, changed, deleted),
  );
  return {
    workTree,
    base,
    mergeBase,
    notices: !listed && changed.length === 0 ? [emptyDiffNotice(workTree, base, mergeBase)] : [],
    changedFiles: listed ? listed.filter((relPath) => changedSet.has(relPath)).length : changed.length,
    wholeFiles: whole.size,
    files,
    touchedFiles: new Set([...files, ...changed, ...deleted]),
    addedRanges,
    nonProduction,
    diffCommits,
    ...(renamedFrom.size > 0 ? { renamedFrom } : {}),
  };
}

/**
 * The evidence corpus's lag behind the tree the answer is about (lexicon
 * friction F2): the registry's `indexedCommit` (stamped at finalize, read by
 * `CommitDriftMonitor` too) against the tree's HEAD. Undefined when either is
 * unknown or they agree — the verdicts then rest on the tree's own commit.
 */
export function readTreeLag(
  collectionRegistry: RegistryLookup,
  collectionName: string,
  workTree: string,
): DiffTreeLag | undefined {
  const indexedCommit = collectionRegistry.get?.(collectionName)?.git?.indexedCommit;
  if (!indexedCommit) return undefined;
  const treeCommit = readEnclosingRepoGitState(workTree)?.commit;
  if (!treeCommit || treeCommit === indexedCommit) return undefined;
  return { indexedCommit, treeCommit };
}

/** A git read of diff mode; a failure (unknown base, not a repository) is the caller's input. */
async function gitRead<T>(base: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new InvalidParameterError("changes.base", `git diff against '${base}' failed: ${errorMessage(error)}`);
  }
}

/**
 * Diff mode's comparison commit (bd tea-rags-mcp-y33ee): `base`'s merge-base
 * with HEAD. A reviewer's `base: "origin/master"` means "what this branch
 * changed", not "how the working tree differs from master's tip" — against a
 * tip that moved on, every file only the base touched reads as the branch's
 * (live on taxdome: 1527 files for a 61-file branch). A commit HEAD descends
 * from is its own merge-base, so an explicit sha is compared as given — and the
 * default base `HEAD` is HEAD's own commit, answered from `headCommit` without
 * a git child when the repository's files named it (bd tea-rags-mcp-0qaht.63).
 */
async function resolveReviewMergeBase(repoRoot: string, base: string, headCommit: string | undefined): Promise<string> {
  if (base === DIFF_DEFAULT_BASE && headCommit !== undefined) return headCommit;
  const mergeBase = await gitRead(base, async () => readMergeBase(repoRoot, base));
  if (mergeBase === null) {
    throw new InvalidParameterError(
      "changes.base",
      `'${base}' and HEAD share no merge-base — unrelated histories, or a shallow clone cut the fork point off ` +
        `(git fetch --deepen / --unshallow); pass as base a commit HEAD descends from`,
    );
  }
  return mergeBase;
}

/**
 * The notice an empty diff carries (lexicon friction F1): `changedFiles: 0`
 * alone reads as "nothing to review" when the review looked at the wrong tree
 * or the wrong base. Names both ways out and the repository's other trees.
 */
function emptyDiffNotice(workTree: string, base: string, mergeBase: string): string {
  const tree = realpathOrSelf(workTree);
  const others = listRepoWorkTrees(tree).filter((other) => other !== tree);
  const elsewhere = others.length === 0 ? "" : ` — this repository's other working trees: ${others.join(", ")}`;
  return (
    `no changes in ${workTree} against ${base} (${mergeBase.slice(0, 7)}): committed work needs changes.base ` +
    `(e.g. main); edits in a git worktree need path=<worktree> beside project${elsewhere}`
  );
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
