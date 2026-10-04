/**
 * The shared diff-scope reader (bd tea-rags-mcp-89k7k.1.1): one read of a
 * working-tree change — the files under the cap, their added line ranges, the
 * merge-base the change is read against, and the bookkeeping (notices, counts,
 * the non-production files) every diff-scoped report consumes. The review sections of
 * `get_naming_lexicon` are its first consumer; the naming-specific half
 * (per-file declaration extraction) stayed behind in `naming-lexicon-ops.ts`.
 *
 * Pure functions on purpose: the read holds no state worth a class, so the
 * next diff-scoped report calls it without a deps interface.
 */

import { realpathSync } from "node:fs";

import { listRepoWorkTrees } from "../../../adapters/vcs/git/common-dir.js";
import {
  listChangedFiles,
  readAddedLineRangesOfFiles,
  readMergeBase,
  type AddedLineRange,
} from "../../../adapters/vcs/git/git-cli/client.js";
import type { CollectionRegistry } from "../../../domains/maintenance/registry/index.js";
import {
  findGitToplevel,
  gitPathFromRoot,
  gitPathPrefix,
  readEnclosingRepoGitState,
  rebaseGitPathsOntoRoot,
} from "../../../infra/repo-git-state.js";
import { InvalidParameterError } from "../../public/errors.js";
import { ontologyNonProductionPathFilter } from "./ontology-report-ops.js";

/** Diff mode: changed files one call reviews; the rest are reported as `skipped`. */
export const DIFF_FILE_CAP = 200;
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
  /** The files under the cap — what evidence exclusion carries. */
  files: readonly string[];
  /** Per reviewed file its added line ranges; a whole-file read is one range over every line. */
  addedRanges: ReadonlyMap<string, readonly AddedLineRange[]>;
  /** The read files the ontology's non-production masks cover — a report skips them, not judges them. */
  nonProduction: ReadonlySet<string>;
  /** How many changed files fell over the cap. */
  skipped: number;
}

/** The evidence corpus's lag behind the tree an answer is about. */
export interface DiffTreeLag {
  indexedCommit: string;
  treeCommit: string;
}

/**
 * One read of a working-tree change (spec §6.1–6.3): the changed files against
 * the base resolved to its merge-base with HEAD (bd tea-rags-mcp-y33ee) —
 * `files` when given, else `git diff --name-only` plus untracked files — capped
 * at {@link DIFF_FILE_CAP} by the relevance order `byReviewRelevance` states
 * (bd tea-rags-mcp-89k7k.1.9); per file its added line ranges. A listed file
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
  const mergeBase = await resolveReviewMergeBase(toplevel, base);
  const changed = rebaseGitPathsOntoRoot(
    await gitRead(base, async () => listChangedFiles(toplevel, mergeBase)),
    prefix,
  );
  const listed = req.files ? unique(req.files) : undefined;
  const all = listed ?? changed;
  const changedSet = new Set(changed);
  const nonProductionFilter = ontologyNonProductionPathFilter();
  // Added-line ranges are read for EVERY candidate file, not the capped few
  // (bd tea-rags-mcp-89k7k.1.9): the cap's relevance order below needs each
  // file's added lines BEFORE choosing which fall over it, and the kept
  // files' ranges come from the same single read. The extra cost over the old
  // capped read is the diff body of the files that get skipped — one git diff
  // invocation either way.
  const ranges = await gitRead(base, async () =>
    readAddedLineRangesOfFiles(
      toplevel,
      mergeBase,
      all.map((relPath) => gitPathFromRoot(relPath, prefix)),
    ),
  );
  const addedLinesOf = (relPath: string): number =>
    (ranges.get(gitPathFromRoot(relPath, prefix)) ?? []).reduce((sum, range) => sum + (range.end - range.start + 1), 0);
  // Over the cap, WHICH files survive is a stated relevance order, not
  // git's listing order (bd tea-rags-mcp-89k7k.1.9) — see the comparator.
  const files =
    all.length > DIFF_FILE_CAP
      ? [...all].sort(byReviewRelevance(addedLinesOf, changedSet, nonProductionFilter)).slice(0, DIFF_FILE_CAP)
      : all.slice(0, DIFF_FILE_CAP);
  const whole = new Set(listed ? files.filter((relPath) => !changedSet.has(relPath)) : []);
  const addedRanges = new Map<string, readonly AddedLineRange[]>(
    files.map((relPath) => [
      relPath,
      whole.has(relPath) ? WHOLE_FILE : (ranges.get(gitPathFromRoot(relPath, prefix)) ?? []),
    ]),
  );

  const nonProduction = new Set(files.filter((relPath) => nonProductionFilter.ignores(relPath)));
  return {
    workTree,
    base,
    mergeBase,
    notices: !listed && changed.length === 0 ? [emptyDiffNotice(workTree, base, mergeBase)] : [],
    changedFiles: listed ? listed.filter((relPath) => changedSet.has(relPath)).length : changed.length,
    wholeFiles: whole.size,
    files,
    addedRanges,
    nonProduction,
    skipped: all.length - files.length,
  };
}

/**
 * The file cap's relevance order (bd tea-rags-mcp-89k7k.1.9): files past the
 * cap used to be whatever sorted last in git's listing order — on a live diff
 * the one production change was dropped while 200 non-production notes
 * survived it, and graph-based sections then read a clean pass over files
 * they never saw. Which files SURVIVE the cap, most relevant first:
 *
 * 1. PRODUCTION before non-production (the ontology's masks) — a report skips
 *    non-production files anyway, so they carry the least review surface.
 * 2. A listed whole-file read before diff-read files — the caller named it
 *    explicitly and its review surface is the entire file.
 * 3. Otherwise MORE added lines first — the file that grew most carries the
 *    most judgement; the fewest-added-lines file is dropped first.
 * 4. Ties break by path ascending, so the kept set is deterministic for a
 *    given diff whatever git's listing order was.
 */
function byReviewRelevance(
  addedLinesOf: (relPath: string) => number,
  changedSet: ReadonlySet<string>,
  nonProductionFilter: { ignores: (relPath: string) => boolean },
): (left: string, right: string) => number {
  return (left, right) => {
    const leftNonProduction = nonProductionFilter.ignores(left) ? 1 : 0;
    const rightNonProduction = nonProductionFilter.ignores(right) ? 1 : 0;
    if (leftNonProduction !== rightNonProduction) return leftNonProduction - rightNonProduction;
    const leftWhole = changedSet.has(left) ? 0 : 1;
    const rightWhole = changedSet.has(right) ? 0 : 1;
    if (leftWhole !== rightWhole) return leftWhole - rightWhole;
    const addedLines = addedLinesOf(right) - addedLinesOf(left);
    if (addedLines !== 0) return addedLines;
    return left < right ? -1 : left > right ? 1 : 0;
  };
}

/**
 * The evidence corpus's lag behind the tree the answer is about (lexicon
 * friction F2): the registry's `indexedCommit` (stamped at finalize, read by
 * `CommitDriftMonitor` too) against the tree's HEAD. Undefined when either is
 * unknown or they agree — the verdicts then rest on the tree's own commit.
 */
export function readTreeLag(
  collectionRegistry: CollectionRegistry,
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
 * from is its own merge-base, so an explicit sha is compared as given.
 */
async function resolveReviewMergeBase(repoRoot: string, base: string): Promise<string> {
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
