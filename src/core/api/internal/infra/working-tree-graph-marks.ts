/**
 * Marks on a graph answer the INDEX's graph gave for a tree whose own graph
 * was unavailable this call (bd tea-rags-mcp-07b9w). The answer stands, but an
 * edge whose file the tree changed may be stale — so that row carries
 * `treeState` with the vocabulary search rows use (`workingTreeStateOf`), and a
 * row without it is exact. The queried subject's own file in the delta is named
 * as `queriedTreeState`; a symbol the index graph does not know but the tree
 * defines answers `treeOnly`, never `unknownSymbol`.
 *
 * `GraphFacade` and `TracePathOps` share it, kept out of both per facade
 * discipline, like the handle selection in `working-tree-graph-read.ts`.
 */
import type { EmptyAnswerExplanation } from "../../../contracts/types/empty-answer.js";
import type { WorkingTreeGraphState, WorkingTreeState } from "../../../contracts/types/working-tree.js";
import { workingTreeStateOf, type WorkingTreeView } from "../../../domains/explore/index.js";

/** Answer arrays whose rows name a file, and the key each row names it under. */
const ROW_PATH_KEYS: Readonly<Record<string, string>> = {
  callers: "sourceRelPath",
  ambiguousCallers: "sourceRelPath",
  callees: "targetRelPath",
  tree: "relPath",
  importers: "relativePath",
  imports: "relativePath",
  steps: "relativePath",
  memberLocations: "relativePath",
};

/** Arrays whose rows hold row arrays of their own (`paths[].steps`, `cycles[].memberLocations`). */
const NESTED_ROW_KEYS = ["paths", "cycles"] as const;

/** A graph answer as the marks see it: any object, with the row arrays above. */
type MarkableGraphAnswer = object & {
  empty?: EmptyAnswerExplanation;
  relativePath?: unknown;
  resolvedSymbolId?: unknown;
};

/**
 * `answer` with its marks, when the index graph answered for a tree that
 * changed files (`state` unavailable, the view's delta non-empty); otherwise
 * `answer` itself. `symbolId` = the symbol the request queried, if any.
 */
export async function markIndexGraphAnswer<T extends object>(
  answer: T,
  view: WorkingTreeView,
  state: WorkingTreeGraphState | undefined,
  symbolId?: string,
): Promise<T & { queriedTreeState?: WorkingTreeState }> {
  if (state?.kind !== "unavailable") return answer;
  if (view.touchedPaths.size === 0 && (view.indexServedPaths?.size ?? 0) === 0) return answer;
  const marked = markRows(answer, view) as T & MarkableGraphAnswer;
  const queried = await queriedState(marked, view, symbolId);
  const withQueried = queried ? { ...marked, queriedTreeState: queried } : marked;
  if (symbolId === undefined || marked.empty?.reason !== "unknownSymbol" || !(await treeDefines(view, symbolId))) {
    return withQueried;
  }
  return { ...withQueried, empty: treeOnlyExplanation(symbolId, state.reason) };
}

function markRows(answer: object, view: WorkingTreeView): object {
  const out: Record<string, unknown> = { ...answer };
  for (const [key, value] of Object.entries(out)) {
    if (!Array.isArray(value)) continue;
    if (key in ROW_PATH_KEYS) out[key] = value.map((row: unknown) => markRow(row, ROW_PATH_KEYS[key], view));
    else if ((NESTED_ROW_KEYS as readonly string[]).includes(key)) {
      out[key] = value.map((row: unknown) => (isRecord(row) ? markRows(row, view) : row));
    }
  }
  return out;
}

function markRow(row: unknown, pathKey: string, view: WorkingTreeView): unknown {
  if (!isRecord(row)) return row;
  const path = row[pathKey];
  const treeState = typeof path === "string" ? workingTreeStateOf(view, path) : undefined;
  return treeState ? { ...row, treeState } : row;
}

/** The queried subject's own tree state: its file (file scope), or a delta file defining it (symbol scope). */
async function queriedState(
  answer: MarkableGraphAnswer,
  view: WorkingTreeView,
  symbolId: string | undefined,
): Promise<WorkingTreeState | undefined> {
  if (symbolId === undefined) {
    return typeof answer.relativePath === "string" ? workingTreeStateOf(view, answer.relativePath) : undefined;
  }
  const resolved = typeof answer.resolvedSymbolId === "string" ? answer.resolvedSymbolId : symbolId;
  return (await treeDefines(view, resolved)) ? "modified" : undefined;
}

/** True when a chunk of the tree's delta defines `symbolId` (the symbol, a `#partN` of it, or a member). */
async function treeDefines(view: WorkingTreeView, symbolId: string): Promise<boolean> {
  if (!view.readDeltaChunks) return false;
  const chunks = await view.readDeltaChunks().catch(() => []);
  return chunks.some(({ payload }) => {
    const own = payload.symbolId;
    return (
      (typeof own === "string" && (own === symbolId || own.startsWith(`${symbolId}#part`))) ||
      payload.parentSymbolId === symbolId
    );
  });
}

function treeOnlyExplanation(symbolId: string, treeGraphReason: string): EmptyAnswerExplanation {
  return {
    reason: "treeOnly",
    message:
      `${symbolId} exists only in your working tree; its graph is unavailable (${treeGraphReason}), ` +
      "so the index graph answered without it. find_symbol reads it; its callers → literal search for its name.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
