/**
 * The working-tree substitution rule (bd tea-rags-mcp-xi2r9.3), stated once.
 *
 * A strategy with the chunk floor drops every base row of a file the tree
 * changed or deleted and takes the tree's rows of those files in their place —
 * only the ones that pass `keep`, the same predicate its Qdrant scroll applied,
 * so a tree row reaches the answer exactly when its indexed twin would have.
 * A strategy without a floor keeps the base rows and names how each is stale
 * through {@link workingTreeStateOf}.
 */
import type { WorkingTreeState } from "../../../contracts/types/working-tree.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import type { WorkingTreeView } from "./overlay.js";

/** Drop rows of touched files, add delta rows passing `keep`. Pure. */
export function substituteWorkingTreeRows(
  scrolled: readonly ScrollChunk[],
  view: WorkingTreeView,
  deltaRows: readonly ScrollChunk[],
  keep: (row: ScrollChunk) => boolean,
): ScrollChunk[] {
  if (view.touchedPaths.size === 0) return [...scrolled];
  const untouched = scrolled.filter((row) => !view.touchedPaths.has(relativePathOf(row.payload)));
  return [...untouched, ...deltaRows.filter(keep)];
}

const SPLIT_PART_SUFFIX = /#part\d+$/;

/** A symbolId with its `#partN` split suffix removed; undefined for a row without one. */
function symbolFamilyOf(payload: Record<string, unknown> | undefined): string | undefined {
  const symbolId = payload?.symbolId;
  return typeof symbolId === "string" && symbolId !== "" ? symbolId.replace(SPLIT_PART_SUFFIX, "") : undefined;
}

/**
 * Base rows a lookup reached through the INDEX (a codegraph hop names a stored
 * chunk by id) retargeted at the tree (live P2-1): a row of a file the tree did
 * not touch stays; a row of a touched file is replaced by the tree's rows of
 * the same file and the same symbol — `#partN` parts of either side count as
 * that symbol — and by nothing when the tree no longer has it (or deleted the
 * file). The index's version of a touched file never survives. Pure.
 */
export function retargetWorkingTreeRows<R extends { payload?: Record<string, unknown> }>(
  rows: readonly R[],
  view: WorkingTreeView,
  deltaRows: readonly ScrollChunk[],
  toResult: (row: ScrollChunk) => R,
): R[] {
  return rows.flatMap((row) => {
    const path = relativePathOf(row.payload);
    if (!view.touchedPaths.has(path)) return [row];
    const family = symbolFamilyOf(row.payload);
    if (family === undefined) return [];
    return deltaRows
      .filter((delta) => relativePathOf(delta.payload) === path && symbolFamilyOf(delta.payload) === family)
      .map(toResult);
  });
}

/** How a base row of `relativePath` differs from the tree; undefined when the tree did not touch it. */
export function workingTreeStateOf(
  view: WorkingTreeView,
  relativePath: string | undefined,
): WorkingTreeState | undefined {
  if (relativePath === undefined || !view.touchedPaths.has(relativePath)) return undefined;
  return view.deletedPaths.has(relativePath) ? "deleted" : "modified";
}

/** The row's file, or "" — a row without a path is never a delta row. */
export function relativePathOf(payload: Record<string, unknown> | undefined): string {
  const path = payload?.relativePath;
  return typeof path === "string" ? path : "";
}
