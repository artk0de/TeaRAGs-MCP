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
