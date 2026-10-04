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

/**
 * Ids of the tree's rows that are the counterparts of the given base points
 * (live round-3 D2): the delta rows of the same symbol — `#partN` windows of
 * either side count as that symbol — in the base point's file, or in the file
 * the delta moved it to (`view.renamedFrom`). A base point of a file the tree
 * did not touch has none. Pure.
 */
export function workingTreeCounterpartIds(
  view: WorkingTreeView,
  deltaRows: readonly ScrollChunk[],
  basePayloads: readonly (Record<string, unknown> | undefined)[],
): Set<string> {
  const familiesByPath = new Map<string, Set<string>>();
  for (const payload of basePayloads) {
    const path = relativePathOf(payload);
    const family = symbolFamilyOf(payload);
    if (family === undefined || !view.touchedPaths.has(path)) continue;
    familiesByPath.set(path, (familiesByPath.get(path) ?? new Set()).add(family));
  }
  const ids = new Set<string>();
  if (familiesByPath.size === 0) return ids;
  const holds = (path: string | undefined, family: string): boolean =>
    path !== undefined && (familiesByPath.get(path)?.has(family) ?? false);
  for (const row of deltaRows) {
    const path = relativePathOf(row.payload);
    const family = symbolFamilyOf(row.payload);
    if (family === undefined) continue;
    if (holds(path, family) || holds(view.renamedFrom?.get(path), family)) ids.add(String(row.id));
  }
  return ids;
}

/**
 * The tree's row of one symbol in one file (live D2): its delta row, or its
 * `#partN` windows merged into one — the first window's payload, the symbol's
 * own id, and the lines from the first window's start to the last one's end.
 * Undefined when the tree has no row of that symbol there. Pure.
 */
export function mergedWorkingTreeSymbolRow(
  deltaRows: readonly ScrollChunk[],
  relativePath: string,
  symbolId: string,
): ScrollChunk | undefined {
  const parts = deltaRows
    .filter((row) => relativePathOf(row.payload) === relativePath && symbolFamilyOf(row.payload) === symbolId)
    .sort((a, b) => lineOf(a.payload.startLine) - lineOf(b.payload.startLine));
  if (parts.length <= 1) return parts[0];
  const ends = parts.map((part) => part.payload.endLine).filter((end): end is number => typeof end === "number");
  return {
    id: parts[0].id,
    payload: {
      ...parts[0].payload,
      symbolId,
      ...(ends.length > 0 ? { endLine: Math.max(...ends) } : {}),
    },
  };
}

function lineOf(value: unknown): number {
  return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
}

/**
 * How a base row of `relativePath` differs from the tree; undefined when the
 * tree did not change it. A file the view serves from the index
 * (`indexServedPaths`) is "modified": the tree changed it, the row is the index's.
 */
export function workingTreeStateOf(
  view: WorkingTreeView,
  relativePath: string | undefined,
): WorkingTreeState | undefined {
  if (relativePath === undefined) return undefined;
  const indexServed = indexServedStateOf(view, relativePath);
  if (indexServed) return indexServed;
  if (!view.touchedPaths.has(relativePath)) return undefined;
  return view.deletedPaths.has(relativePath) ? "deleted" : "modified";
}

/**
 * "modified" when the view serves `relativePath` from the index
 * (`indexServedPaths`), else undefined. The half of `workingTreeStateOf` that
 * holds in every strategy: a floor replaces only touched files, never these.
 */
export function indexServedStateOf(
  view: WorkingTreeView,
  relativePath: string | undefined,
): WorkingTreeState | undefined {
  return relativePath !== undefined && view.indexServedPaths?.has(relativePath) ? "modified" : undefined;
}

/** The row's file, or "" — a row without a path is never a delta row. */
export function relativePathOf(payload: Record<string, unknown> | undefined): string {
  const path = payload?.relativePath;
  return typeof path === "string" ? path : "";
}
