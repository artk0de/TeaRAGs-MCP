/**
 * Rename following for the chunk churn walk (bd tea-rags-mcp-z8w16).
 *
 * The walk's chunk map is keyed on HEAD paths, but a commit names each file by
 * its path AS OF THAT COMMIT. A commit made before a rename therefore names a
 * path the map does not know, and was dropped. Two steps close that gap without
 * touching discovery or its stores:
 *
 * 1. `sliceCommitsFollowingRenames` widens the slice: a HEAD-keyed slice holds
 *    the rename commit (its row carries `previousPath`) but never a commit that
 *    touched only the old path, so the old path is queried too — to a fixpoint,
 *    which is what makes chains compose.
 * 2. `resolveHeadPaths` walks the slice newest → oldest keeping an alias map
 *    (name at this point of history → HEAD path, or `null` for a file that does
 *    not survive to HEAD) and updates it at every rename row it passes. Because
 *    the map is only rewritten at the rename commit, a path RE-CREATED after
 *    the rename keeps its own identity for the newer commits, while the older
 *    commits under the same name follow the renamed file.
 */

import type { CommitChangedPath } from "../../../../adapters/vcs/types.js";

/** Minimal slice row shape: anything carrying the commit's changed-path pairs. */
interface CommitSliceRow {
  changedFiles: CommitChangedPath[];
}

/** A changed-path row paired with the HEAD path whose chunks it credits. */
export interface HeadAttributedChangedPath {
  changed: CommitChangedPath;
  headPath: string;
}

/**
 * Query `filePaths` plus every predecessor path a rename row reveals, until no
 * new predecessor appears. Returns the result of the last query, i.e. ONE slice
 * in the query's own (log) order — `resolveHeadPaths` depends on that order.
 *
 * Over-fetching is harmless: a commit pulled in by a predecessor path that
 * turns out to belong to a different file is dropped by `resolveHeadPaths`.
 */
export async function sliceCommitsFollowingRenames<T extends CommitSliceRow>(
  query: (filePaths: string[]) => Promise<T[]>,
  filePaths: string[],
): Promise<T[]> {
  const queried = new Set(filePaths);
  for (;;) {
    const entries = await query([...queried]);
    let widened = false;
    for (const { changedFiles } of entries) {
      for (const { path, previousPath } of changedFiles) {
        if (previousPath === undefined || !queried.has(path) || queried.has(previousPath)) continue;
        queried.add(previousPath);
        widened = true;
      }
    }
    if (!widened) return entries;
  }
}

/**
 * Attribute every changed-path row of a newest → oldest commit list to the
 * HEAD path it belongs to. Output is parallel to `entries`; a row whose file
 * does not survive to HEAD under any name is omitted.
 *
 * At a rename row `{ path: B, previousPath: A }` (applied AFTER the commit's own
 * rows are attributed, since those name the post-commit state):
 * - `A` now names the renamed file, so older commits under `A` resolve to B's
 *   HEAD path — chains compose because B is itself resolved through the map;
 * - `B` did not exist before this commit, so an older commit under `B` touched
 *   a different, since-deleted file and resolves to nothing.
 * Predecessor mappings are applied last so a same-commit swap (A→B, B→A)
 * resolves both names.
 */
export function resolveHeadPaths(entries: readonly CommitSliceRow[]): HeadAttributedChangedPath[][] {
  const aliases = new Map<string, string | null>();
  const resolve = (path: string): string | null => {
    const alias = aliases.get(path);
    return alias === undefined ? path : alias;
  };

  return entries.map(({ changedFiles }) => {
    const rows: HeadAttributedChangedPath[] = [];
    const bornHere: string[] = [];
    const predecessors: [string, string | null][] = [];
    for (const changed of changedFiles) {
      const headPath = resolve(changed.path);
      if (headPath !== null) rows.push({ changed, headPath });
      if (changed.previousPath !== undefined && changed.previousPath !== changed.path) {
        bornHere.push(changed.path);
        predecessors.push([changed.previousPath, headPath]);
      }
    }
    for (const path of bornHere) aliases.set(path, null);
    for (const [previousPath, headPath] of predecessors) aliases.set(previousPath, headPath);
    return rows;
  });
}
