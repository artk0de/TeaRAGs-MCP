/**
 * WorkingTreeDelta (bd tea-rags-mcp-xi2r9.2) — the files a working tree reads
 * differently from the commit its base index was built at.
 *
 * changed = every path `git diff --no-renames <indexedCommit>` lists as not
 * deleted, plus untracked non-ignored files; deleted = the `D` entries, so a
 * move is its source deleted plus its target changed. Both pass the ingest
 * admission rule (`FileScanner#accepts`) the caller hands in, so the delta
 * never names a file ingest would not have indexed. Which changed path git
 * pairs with which deleted one rides beside them in `renamedFrom` (bd
 * tea-rags-mcp-xi2r9, D12), read only when something was deleted: a moved
 * file's history is its old path's.
 *
 * Reads are cached per tree under a fingerprint of the status text (which
 * carries HEAD) plus `mtime:size` of every path status lists: status alone does
 * not move when an already-modified file is edited again. A clean tree at the
 * indexed commit costs one status spawn and no diff.
 *
 * `root` may be a SUBDIRECTORY of its git toplevel — the tree's counterpart of
 * an index registered below its repository's root (live P2-2). Git is asked at
 * the toplevel, where every path it reports is toplevel-relative; the delta
 * keeps the files under `root` and names them relative to it, as the index
 * does. Asking from the subdirectory would mix two bases: `git diff` names
 * toplevel-relative paths while `ls-files --others` names cwd-relative ones.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  readStatusPorcelain,
  readWorkingTreeChanges,
  readWorkingTreeRenames,
} from "../../../adapters/vcs/git/git-cli/client.js";
import { findGitToplevel, gitPathPrefix, rebaseGitPathsOntoRoot } from "../../../infra/repo-git-state.js";

export interface WorkingTreeDelta {
  /** root-relative, includes untracked files and rename targets */
  changed: readonly string[];
  /** root-relative, includes rename sources */
  deleted: readonly string[];
  /**
   * Moves git pairs: a `changed` path → the `deleted` path it was moved from
   * (staged, unstaged or committed since the indexed commit, edits within git's
   * similarity threshold included). The touched sets above stay exact; this only
   * says whose history a moved file carries. Empty or absent → no moves.
   */
  renamedFrom?: ReadonlyMap<string, string>;
  fingerprint: string;
}

export type WorkingTreeDeltaRead =
  | { kind: "measured"; delta: WorkingTreeDelta }
  | { kind: "degraded"; reason: string; remedy: string };

/** Remedies carry `{alias}` / `{tree}` tokens the overlay fills in. */
export const WORKING_TREE_REINDEX_REMEDY = "tea-rags index-codebase --project {alias}";

export interface WorkingTreeDeltaReader {
  read: (
    root: string,
    indexedCommit: string | null,
    accepts: (relativePath: string) => boolean,
  ) => Promise<WorkingTreeDeltaRead>;
}

interface WorkingTreeStatusSnapshot {
  head: string | null;
  paths: string[];
}

/** HEAD and every listed path of a `--porcelain=v2 -z --branch` status text. */
function parseStatusPorcelain(status: string): WorkingTreeStatusSnapshot {
  const fields = status.split("\0").filter((field) => field.length > 0);
  let head: string | null = null;
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    switch (field[0]) {
      case "#":
        if (field.startsWith("# branch.oid ")) {
          const oid = field.slice("# branch.oid ".length);
          head = oid === "(initial)" ? null : oid;
        }
        break;
      case "1":
        paths.push(field.split(" ").slice(8).join(" "));
        break;
      case "2":
        // A rename entry is followed by its original path as the next field.
        paths.push(field.split(" ").slice(9).join(" "));
        if (i + 1 < fields.length) paths.push(fields[++i]);
        break;
      case "u":
        paths.push(field.split(" ").slice(10).join(" "));
        break;
      default:
        // "? path" untracked, "! path" ignored.
        paths.push(field.slice(2));
    }
  }
  return { head, paths };
}

async function statStamp(root: string, relativePath: string): Promise<string> {
  try {
    const stat = await fs.stat(join(root, relativePath));
    return `${relativePath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${relativePath}:-`;
  }
}

async function fingerprintOf(
  root: string,
  indexedCommit: string,
  status: string,
  snapshot: WorkingTreeStatusSnapshot,
): Promise<string> {
  const stamps = await Promise.all([...new Set(snapshot.paths)].sort().map(async (path) => statStamp(root, path)));
  return createHash("sha1")
    .update(indexedCommit)
    .update("\0")
    .update(snapshot.head ?? "")
    .update("\0")
    .update(status)
    .update("\0")
    .update(stamps.join("\n"))
    .digest("hex");
}

/** Git exits 128 for an unknown revision. */
function isUnknownRevision(error: unknown): boolean {
  return error instanceof Error && error.message.includes("(exit 128)");
}

async function measureDelta(
  gitToplevel: string,
  prefix: string,
  indexedCommit: string,
  accepts: (relativePath: string) => boolean,
  fingerprint: string,
): Promise<WorkingTreeDeltaRead> {
  let changes: Awaited<ReturnType<typeof readWorkingTreeChanges>>;
  try {
    changes = await readWorkingTreeChanges(gitToplevel, indexedCommit);
  } catch (error) {
    if (!isUnknownRevision(error)) throw error;
    return {
      kind: "degraded",
      reason: `indexed commit ${indexedCommit.slice(0, 7)} is not in this repository`,
      remedy: WORKING_TREE_REINDEX_REMEDY,
    };
  }
  const changed = rebaseGitPathsOntoRoot(changes.changed, prefix).filter(accepts);
  const deleted = rebaseGitPathsOntoRoot(changes.deleted, prefix).filter(accepts);
  const renamedFrom = await readRenamePairs(gitToplevel, prefix, indexedCommit, changes.untracked, changed, deleted);
  return { kind: "measured", delta: { changed, deleted, renamedFrom, fingerprint } };
}

/**
 * The delta's moves, root-relative: a second, rename-detecting diff run only
 * when the delta deleted something — no deletion, no move. Only the delta's
 * own untracked files are offered to git as move targets, and a pair is kept
 * only when both sides are in the delta (under the root, admitted by ingest).
 */
async function readRenamePairs(
  gitToplevel: string,
  prefix: string,
  indexedCommit: string,
  untracked: readonly string[],
  changed: readonly string[],
  deleted: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const renamedFrom = new Map<string, string>();
  if (deleted.length === 0 || changed.length === 0) return renamedFrom;
  const changedSet = new Set(changed);
  const deletedSet = new Set(deleted);
  const candidates = untracked.filter((path) => {
    const [rootRelative] = rebaseGitPathsOntoRoot([path], prefix);
    return rootRelative !== undefined && changedSet.has(rootRelative);
  });
  for (const { from, to } of await readWorkingTreeRenames(gitToplevel, indexedCommit, candidates)) {
    const [oldPath] = rebaseGitPathsOntoRoot([from], prefix);
    const [newPath] = rebaseGitPathsOntoRoot([to], prefix);
    if (oldPath !== undefined && newPath !== undefined && deletedSet.has(oldPath) && changedSet.has(newPath)) {
      renamedFrom.set(newPath, oldPath);
    }
  }
  return renamedFrom;
}

/** A reader with its own per-tree cache; one per process is the intended use. */
export function createWorkingTreeDeltaReader(): WorkingTreeDeltaReader {
  const cache = new Map<string, { fingerprint: string; read: WorkingTreeDeltaRead }>();

  return {
    read: async (root, indexedCommit, accepts) => {
      if (indexedCommit === null) {
        return { kind: "degraded", reason: "index has no indexedCommit stamp", remedy: WORKING_TREE_REINDEX_REMEDY };
      }
      const gitToplevel = findGitToplevel(root) ?? root;
      const prefix = gitPathPrefix(gitToplevel, root);
      const status = await readStatusPorcelain(gitToplevel);
      const snapshot = parseStatusPorcelain(status);
      const fingerprint = await fingerprintOf(gitToplevel, indexedCommit, status, snapshot);

      const cached = cache.get(root);
      if (cached?.fingerprint === fingerprint) return cached.read;

      const read: WorkingTreeDeltaRead =
        snapshot.paths.length === 0 && snapshot.head === indexedCommit
          ? { kind: "measured", delta: { changed: [], deleted: [], renamedFrom: new Map(), fingerprint } }
          : await measureDelta(gitToplevel, prefix, indexedCommit, accepts, fingerprint);
      cache.set(root, { fingerprint, read });
      return read;
    },
  };
}
