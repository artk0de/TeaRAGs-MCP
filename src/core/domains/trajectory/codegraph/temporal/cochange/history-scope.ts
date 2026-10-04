/**
 * Scope repo history to the project's file space (bd tea-rags-mcp-x4rpp).
 *
 * The discovery matrix names files by their path AS OF each commit, relative to
 * the REPO root. The co-change graph is read against the collection, whose
 * paths are HEAD paths relative to the PROJECT root. Three steps close the gap:
 *
 * 1. rename following — `resolveHeadPaths`, the chunk walk's own rule, so a
 *    file's history does not split at a rename and a since-renamed-away path
 *    does not come back as a phantom file;
 * 2. subtree scoping — a project indexed from a repo subdirectory keeps only
 *    its own files, re-rooted;
 * 3. liveness — a file that is not live (the builder: tracked at HEAD and
 *    still in the working tree) is dropped: its pairs describe code that no
 *    longer exists, and plain deletions are invisible to rename following.
 *
 * Merge commits are dropped by parent count. The subject is NOT consulted: a
 * numstat row IS attributable history, and a single-parent commit whose
 * subject says "Merge ..." carries real changes — a squash-merged PR, or the
 * grafted root of a shallow clone, whose whole-tree diff this rule must keep
 * (bd tea-rags-mcp-12x1y). A true merge arrives with no numstat rows at all,
 * so the parent check is the only arm that fires.
 */

import type { RelPath } from "../../../../../contracts/types/codegraph.js";
import { resolveHeadPaths, type GitCommitDiscoveryEntry } from "../../../git/index.js";
import type { CochangeCommit } from "./commit-bundles.js";

export interface CochangeHistoryScope {
  /** The project root relative to the repo root, POSIX, with a trailing `/`; `""` when they coincide. */
  projectPrefix: string;
  /**
   * Whether a PROJECT-relative path is live now. The builder answers from git
   * (tracked at HEAD, not deleted in the working tree), never from the disk
   * alone — an ignored file can reuse a once-committed path.
   */
  fileExists: (relPath: RelPath) => boolean;
}

/** `entries` newest → oldest (discovery order); returns the scoped commits in the same order. */
export function scopeCochangeHistory(
  entries: readonly GitCommitDiscoveryEntry[],
  scope: CochangeHistoryScope,
): CochangeCommit[] {
  const attributed = resolveHeadPaths(entries);
  const exists = new Map<RelPath, boolean>();
  const existsCached = (relPath: RelPath): boolean => {
    let hit = exists.get(relPath);
    if (hit === undefined) {
      hit = scope.fileExists(relPath);
      exists.set(relPath, hit);
    }
    return hit;
  };

  const scoped: CochangeCommit[] = [];
  entries.forEach(({ commit }, index) => {
    if (commit.parents.length > 1) return;
    const files = new Set<RelPath>();
    for (const { headPath } of attributed[index]) {
      if (!headPath.startsWith(scope.projectPrefix)) continue;
      const relPath = headPath.slice(scope.projectPrefix.length);
      if (relPath.length > 0 && existsCached(relPath)) files.add(relPath);
    }
    if (files.size > 0) scoped.push({ commit, files: [...files] });
  });
  return scoped;
}
