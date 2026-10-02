/**
 * WorkingTreeDelta (bd tea-rags-mcp-xi2r9.2) — the files a working tree reads
 * differently from the commit its base index was built at.
 *
 * changed = every path `git diff --no-renames <indexedCommit>` lists as not
 * deleted, plus untracked non-ignored files; deleted = the `D` entries, so a
 * move is its source deleted plus its target changed. Both pass the ingest
 * admission rule (`FileScanner#accepts`) the caller hands in, so the delta
 * never names a file ingest would not have indexed.
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
import { join, relative, sep } from "node:path";

import { readStatusPorcelain, readWorkingTreeChanges } from "../../../adapters/vcs/git/git-cli/client.js";
import { WORKING_TREE_DELTA_FILE_CAP } from "../../../contracts/types/working-tree.js";
import { findGitToplevel } from "../../../infra/repo-git-state.js";

export interface WorkingTreeDelta {
  /** root-relative, includes untracked files and rename targets */
  changed: readonly string[];
  /** root-relative, includes rename sources */
  deleted: readonly string[];
  fingerprint: string;
}

export type WorkingTreeDeltaRead =
  | { kind: "measured"; delta: WorkingTreeDelta }
  | { kind: "degraded"; reason: string; remedy: string };

export { WORKING_TREE_DELTA_FILE_CAP };

/** Remedies carry `{alias}` / `{tree}` tokens the overlay fills in. */
export const WORKING_TREE_REINDEX_REMEDY = "tea-rags index-codebase --project {alias}";
export const WORKING_TREE_WORKTREE_INDEX_REMEDY = "tea-rags worktree create <name> --from {alias} --path {tree}";

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

/**
 * Toplevel-relative git paths → the ones under `prefix` (the root's path below
 * the toplevel, "/"-separated; "" when the root IS the toplevel), relative to it.
 */
function rebaseOntoRoot(paths: readonly string[], prefix: string): string[] {
  if (prefix === "") return [...paths];
  const head = `${prefix}/`;
  return paths.filter((path) => path.startsWith(head)).map((path) => path.slice(head.length));
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
  const changed = rebaseOntoRoot(changes.changed, prefix).filter(accepts);
  const deleted = rebaseOntoRoot(changes.deleted, prefix).filter(accepts);
  const total = changed.length + deleted.length;
  if (total > WORKING_TREE_DELTA_FILE_CAP) {
    return {
      kind: "degraded",
      reason: `delta of ${total} files over the ${WORKING_TREE_DELTA_FILE_CAP}-file cap`,
      remedy: WORKING_TREE_WORKTREE_INDEX_REMEDY,
    };
  }
  return { kind: "measured", delta: { changed, deleted, fingerprint } };
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
      const prefix = relative(gitToplevel, root).split(sep).join("/");
      const status = await readStatusPorcelain(gitToplevel);
      const snapshot = parseStatusPorcelain(status);
      const fingerprint = await fingerprintOf(gitToplevel, indexedCommit, status, snapshot);

      const cached = cache.get(root);
      if (cached?.fingerprint === fingerprint) return cached.read;

      const read: WorkingTreeDeltaRead =
        snapshot.paths.length === 0 && snapshot.head === indexedCommit
          ? { kind: "measured", delta: { changed: [], deleted: [], fingerprint } }
          : await measureDelta(gitToplevel, prefix, indexedCommit, accepts, fingerprint);
      cache.set(root, { fingerprint, read });
      return read;
    },
  };
}
