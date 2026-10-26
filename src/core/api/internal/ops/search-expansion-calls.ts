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
 * rarely edited anchors answered `noHistory` — so co-change goes last.
 *
 * Built from the answer's own rows: no graph-DB read at answer time. An unbuilt
 * co-change layer answers `built: false` from `find_co_changed` itself.
 */

import type { SuggestedToolCall } from "../../../contracts/types/suggested-tool-call.js";
import type { WorkingTreeMarker } from "../../../contracts/types/working-tree.js";
import { toolCallAddressFromWorkingTree } from "../../../domains/explore/index.js";
import { DOCUMENTATION_LANGUAGES } from "../../../domains/ingest/pipeline/chunker/language-config/index.js";
import { isTestPayload } from "../../../domains/trajectory/static/index.js";

/** Files the hints anchor on: graph neighbours of the first, co-change of the pair. */
const ANCHOR_FILES = 2;

/**
 * The hints for an answer: `get_callees` and `get_callers` on its top distinct
 * code file, then `find_co_changed` on the top two. Rows are taken in answer
 * order (the ranking, or find_symbol's row order); a file's chunks collapse to
 * one anchor; doc and test rows never anchor. Empty when no row is left — the
 * caller then omits `next`.
 */
export function buildSearchExpansionCalls(
  results: readonly { payload?: Record<string, unknown> }[],
  workingTree: WorkingTreeMarker | undefined,
): SuggestedToolCall[] {
  const anchors: string[] = [];
  for (const { payload } of results) {
    const relativePath = payload?.relativePath;
    if (typeof relativePath !== "string" || !isAnchorRow(payload) || anchors.includes(relativePath)) continue;
    anchors.push(relativePath);
    if (anchors.length === ANCHOR_FILES) break;
  }
  if (anchors.length === 0) return [];
  const address = toolCallAddressFromWorkingTree(workingTree);
  const [top] = anchors;
  return [
    {
      tool: "get_callees",
      args: { ...address, relativePath: top },
      why: `files ${top} imports — change candidates`,
    },
    {
      tool: "get_callers",
      args: { ...address, relativePath: top },
      why: `files importing ${top} — callers to update`,
    },
    {
      tool: "find_co_changed",
      args: { ...address, files: anchors },
      why: `files co-edited with ${anchors.join(", ")} in git history`,
    },
  ];
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
