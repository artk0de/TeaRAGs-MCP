/**
 * `next` expansion hints on a search or find_symbol answer (agent turn economy
 * N5, bd tea-rags-mcp-r4rl1, q1g6s.2).
 *
 * In localization the agent finds an anchor and stops, while the anchor's
 * graph and co-change neighbours hold a large share of the files it needed.
 * A rule in the prompt is far from where it decides to stop — the answer is
 * not — so the answer carries the expansion calls ready to run.
 *
 * Order is by measured yield (q1g6s.2): the anchor's callees (helpers it
 * imports) and callers found gold files on a Rails benchmark, co-change on
 * rarely edited anchors answered `noHistory` — so co-change goes last, and a
 * search answer carries none (q1g6s.15: 348 hints offered, 1 followed).
 *
 * Built from the answer's own rows: no graph-DB read at answer time. An unbuilt
 * co-change layer answers `built: false` from `find_co_changed` itself.
 */

import type { SuggestedToolCall } from "../../../contracts/types/suggested-tool-call.js";
import type { WorkingTreeMarker } from "../../../contracts/types/working-tree.js";
import { splitFragmentBase, toolCallAddressFromWorkingTree } from "../../../domains/explore/index.js";
import { DOCUMENTATION_LANGUAGES } from "../../../domains/ingest/pipeline/chunker/language-config/index.js";
import { isTestPayload } from "../../../domains/trajectory/static/index.js";

/** Files the hints anchor on: graph neighbours of the first, co-change of the pair. */
const ANCHOR_FILES = 2;

/**
 * What the graph hints address (q1g6s.15). `relativePath` answers IMPORT edges
 * only, so a hint on a code row by its file never reaches the call graph:
 *
 * - `row` (search answers): the top row's code symbolId, else its file — two
 *   hints at most, no co-change.
 * - `symbol` (find_symbol `symbol` / `symbols`): the first symbol the answer
 *   names, call edges only — no file-level hint the agent did not ask about.
 * - `file` (find_symbol `relativePath`): the file the answer outlines.
 */
export type SearchExpansionScope = "row" | "symbol" | "file";

type ExpansionRow = { payload?: Record<string, unknown> };

/**
 * The hints for an answer: `get_callees` and `get_callers` on its top anchor,
 * then (file scope only) `find_co_changed` on the top two distinct files.
 * Rows are taken in answer order (the ranking, or find_symbol's row order);
 * doc and test rows never anchor. Empty when no row is left — the caller then
 * omits `next`.
 */
export function buildSearchExpansionCalls(
  results: readonly ExpansionRow[],
  workingTree: WorkingTreeMarker | undefined,
  scope: SearchExpansionScope = "row",
): SuggestedToolCall[] {
  const rows = results.flatMap(({ payload }) => (isAnchorRow(payload) ? [payload] : []));
  const address = toolCallAddressFromWorkingTree(workingTree);
  if (scope === "symbol") {
    const symbolId = rows.map(codeSymbolIdOf).find((id) => id !== undefined);
    return symbolId === undefined ? [] : graphCalls(address, { symbolId }, symbolId);
  }
  const anchors: string[] = [];
  for (const payload of rows) {
    const { relativePath } = payload;
    if (typeof relativePath !== "string" || anchors.includes(relativePath)) continue;
    anchors.push(relativePath);
    if (anchors.length === ANCHOR_FILES) break;
  }
  if (anchors.length === 0) return [];
  const [top] = anchors;
  if (scope === "row") {
    const topSymbolId = codeSymbolIdOf(rows[0]);
    return topSymbolId === undefined
      ? graphCalls(address, { relativePath: top }, top)
      : graphCalls(address, { symbolId: topSymbolId }, topSymbolId);
  }
  return [
    ...graphCalls(address, { relativePath: top }, top),
    {
      tool: "find_co_changed",
      args: { ...address, files: anchors },
      why: `files co-edited with ${anchors.join(", ")} in git history`,
    },
  ];
}

/** `get_callees` then `get_callers` on one target: a symbol's call edges, or a file's import edges. */
function graphCalls(
  address: ReturnType<typeof toolCallAddressFromWorkingTree>,
  target: { symbolId: string } | { relativePath: string },
  name: string,
): SuggestedToolCall[] {
  const why =
    "symbolId" in target
      ? { out: `what ${name} calls — change candidates`, in: `callers of ${name} — callers to update` }
      : { out: `files ${name} imports — change candidates`, in: `files importing ${name} — callers to update` };
  return [
    { tool: "get_callees", args: { ...address, ...target }, why: why.out },
    { tool: "get_callers", args: { ...address, ...target }, why: why.in },
  ];
}

/**
 * The graph id a row names: its symbolId, a `#partN` window read as the symbol
 * it splits; undefined for a doc section (`doc:<hash>`) or a row with none.
 */
function codeSymbolIdOf(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const { symbolId } = payload;
  if (typeof symbolId !== "string" || symbolId.length === 0 || symbolId.startsWith("doc:")) return undefined;
  return splitFragmentBase(payload) ?? symbolId;
}

/** A code row of production code: neither a doc chunk nor a test file. */
function isAnchorRow(payload: Record<string, unknown> | undefined): payload is Record<string, unknown> {
  return payload !== undefined && !isDocumentationRow(payload) && !isTestPayload(payload);
}

function isDocumentationRow(payload: Record<string, unknown>): boolean {
  if (payload.isDocumentation === true) return true;
  const { language } = payload;
  return typeof language === "string" && DOCUMENTATION_LANGUAGES.has(language);
}
