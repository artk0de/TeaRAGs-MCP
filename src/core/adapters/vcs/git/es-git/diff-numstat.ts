/**
 * Per-commit numstat row collection over es-git tree diffs — the in-process
 * equivalent of one commit's `git log --numstat` block.
 *
 * Rename detection mirrors the git CLI: `git log` (porcelain) honors the
 * `diff.renames` config, which DEFAULTS TO ON since git 2.9 — a pure rename
 * is ONE `0 0 pfx{old => new}sfx` row, not delete+add (empirically pinned by
 * the equivalence fixture). libgit2 never reads that config on its own, so
 * the effective mode is resolved once from the repo config and drives an
 * explicit `findSimilar` call.
 */

import type { Diff, DiffDelta, Repository } from "es-git";

import { parsePatchNumstatSections } from "./patch-numstat.js";

/** Rename/copy detection mode mirroring the repo's effective `diff.renames`. */
export type RenameDetectionMode = "off" | "renames" | "copies";

/** One numstat file row of one commit, pre-aggregation. */
export interface EsGitNumstatRow {
  /** numstat path column — combined `pfx{old => new}sfx` form for renames/copies. */
  filePath: string;
  added: number;
  deleted: number;
  /** Binary rows (`-\t-` on the CLI) are skipped by churn maps AND changedFiles. */
  binary: boolean;
}

/**
 * git's rename-candidate cap for diff/log (`diff.renameLimit` default);
 * libgit2's own default (200) is far lower and would silently diverge on
 * commits touching many files.
 */
const GIT_DEFAULT_RENAME_LIMIT = 1000;

/**
 * Resolve the effective `diff.renames` once per opened repository. Unset ⇒
 * git's default: rename detection ON. Boolean spellings follow git's config
 * coercion; `copies`/`copy` additionally enable copy detection.
 */
export function readRenameDetectionMode(repo: Repository): RenameDetectionMode {
  let raw: string | null;
  try {
    raw = repo.config().findString("diff.renames");
  } catch {
    return "renames";
  }
  if (raw === null) return "renames";
  const value = raw.toLowerCase();
  if (value === "false" || value === "no" || value === "off" || value === "0") return "off";
  if (value === "copies" || value === "copy") return "copies";
  return "renames";
}

/** Tree diff `parent → commit` (root commits diff against the empty tree). */
export function buildTreeDiff(
  repo: Repository,
  parentSha: string | null,
  commitSha: string,
  pathspecs?: string[],
  contextLines?: number,
): Diff {
  const newTree = repo.getCommit(commitSha).tree();
  const oldTree = parentSha === null ? undefined : repo.getCommit(parentSha).tree();
  return repo.diffTreeToTree(oldTree, newTree, {
    ...(pathspecs !== undefined && pathspecs.length > 0 ? { pathspecs } : {}),
    ...(contextLines !== undefined ? { contextLines } : {}),
  });
}

/** TREESAME probe: does the (pathspec-restricted) tree diff carry any delta? */
export function hasAnyDelta(diff: Diff): boolean {
  return diff.deltas().next().done !== true;
}

function drainDeltas(diff: Diff): DiffDelta[] {
  const deltas: DiffDelta[] = [];
  const iterator = diff.deltas();
  for (let result = iterator.next(); result.done !== true; result = iterator.next()) {
    deltas.push(result.value);
  }
  return deltas;
}

/**
 * Port of git's `pprint_rename` (diff.c) — the combined numstat/stat path for
 * renamed/copied files: longest common component-aligned prefix and suffix
 * around a `{old => new}` core, or a plain `old => new` when neither exists.
 * The c-quoting branch (paths needing octal escapes) is intentionally not
 * ported — the CLI parsers receive those quoted forms opaquely either way.
 */
export function combinedRenamePath(oldPath: string, newPath: string): string {
  const lenOld = oldPath.length;
  const lenNew = newPath.length;

  let prefix = 0;
  for (let i = 0; i < lenOld && i < lenNew && oldPath[i] === newPath[i]; i++) {
    if (oldPath[i] === "/") prefix = i + 1;
  }

  // Walk back from the virtual NUL terminators; with a non-empty prefix the
  // loop may run one char into it to see the prefix's own '/' (as in git).
  let suffix = 0;
  const floor = prefix - (prefix > 0 ? 1 : 0);
  const charAt = (s: string, i: number): string => (i === s.length ? "\0" : s[i]);
  for (let a = lenOld, b = lenNew; a >= floor && b >= floor && charAt(oldPath, a) === charAt(newPath, b); a--, b--) {
    if (oldPath[a] === "/") suffix = lenOld - a;
  }

  if (prefix + suffix === 0) return `${oldPath} => ${newPath}`;
  const oldMid = Math.max(lenOld - prefix - suffix, 0);
  const newMid = Math.max(lenNew - prefix - suffix, 0);
  const head = oldPath.slice(0, prefix);
  const tail = oldPath.slice(lenOld - suffix);
  return `${head}{${oldPath.slice(prefix, prefix + oldMid)} => ${newPath.slice(prefix, prefix + newMid)}}${tail}`;
}

/** numstat path column for one delta (rename detection may already have run). */
function numstatPath(delta: DiffDelta): string {
  const status = delta.status();
  const oldPath = delta.oldFile().path();
  const newPath = delta.newFile().path();
  if ((status === "Renamed" || status === "Copied") && oldPath !== null && newPath !== null && oldPath !== newPath) {
    return combinedRenamePath(oldPath, newPath);
  }
  if (status === "Deleted") return oldPath ?? "";
  return newPath ?? oldPath ?? "";
}

/**
 * One commit's numstat rows: tree diff vs first parent (empty tree for
 * roots), optional pathspec restriction, rename detection per `renameMode`,
 * counts read from a zero-context printed patch (see patch-numstat.ts).
 */
export function collectCommitNumstatRows(
  repo: Repository,
  parentSha: string | null,
  commitSha: string,
  renameMode: RenameDetectionMode,
  pathspecs?: string[],
): EsGitNumstatRow[] {
  const diff = buildTreeDiff(repo, parentSha, commitSha, pathspecs, 0);
  if (renameMode !== "off") {
    diff.findSimilar({
      renames: true,
      copies: renameMode === "copies",
      renameLimit: GIT_DEFAULT_RENAME_LIMIT,
    });
  }
  const deltas = drainDeltas(diff);
  if (deltas.length === 0) return [];

  const sections = parsePatchNumstatSections(diff.print({ format: "Patch" }));
  if (sections.length !== deltas.length) {
    // Invariant of the print format contract, not a user-facing condition.
    throw new Error(
      `es-git printed ${sections.length} patch sections for ${deltas.length} deltas at ${commitSha} — ` +
        `patch-numstat parsing no longer matches the es-git print format`,
    );
  }

  return deltas.map((delta, index) => ({
    filePath: numstatPath(delta),
    added: sections[index].added,
    deleted: sections[index].deleted,
    binary: sections[index].binary,
  }));
}
