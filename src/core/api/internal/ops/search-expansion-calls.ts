/**
 * `next` expansion hints on a search answer (agent turn economy N5, bd
 * tea-rags-mcp-r4rl1).
 *
 * In localization the agent finds an anchor and stops, while the anchor's
 * co-change and importer neighbours hold a large share of the files it needed.
 * A rule in the prompt is far from where it decides to stop — the answer is
 * not — so the answer carries the two expansion calls ready to run.
 *
 * Built from the answer's own rows: no graph-DB read at search time. An unbuilt
 * co-change layer answers `built: false` from `find_co_changed` itself.
 */

import type { SuggestedToolCall } from "../../../contracts/types/suggested-tool-call.js";
import type { WorkingTreeMarker } from "../../../contracts/types/working-tree.js";
import { toolCallAddressFromWorkingTree } from "../../../domains/explore/index.js";
import { DOCUMENTATION_LANGUAGES } from "../../../domains/ingest/pipeline/chunker/language-config/index.js";

/** Files the hints anchor on: co-change of the pair, callers of the first. */
const ANCHOR_FILES = 2;

/**
 * The hints for a ranked answer: `find_co_changed` on its top two distinct code
 * files and `get_callers` on the top one. Rows are taken in answer order (the
 * ranking); a file's chunks collapse to one anchor; doc chunks never anchor.
 * Empty when no code row is left — the caller then omits `next`.
 */
export function buildSearchExpansionCalls(
  results: readonly { payload?: Record<string, unknown> }[],
  workingTree: WorkingTreeMarker | undefined,
): SuggestedToolCall[] {
  const anchors: string[] = [];
  for (const { payload } of results) {
    const relativePath = payload?.relativePath;
    if (typeof relativePath !== "string" || isDocumentationRow(payload) || anchors.includes(relativePath)) continue;
    anchors.push(relativePath);
    if (anchors.length === ANCHOR_FILES) break;
  }
  if (anchors.length === 0) return [];
  const address = toolCallAddressFromWorkingTree(workingTree);
  return [
    {
      tool: "find_co_changed",
      args: { ...address, files: anchors },
      why: "files usually edited together with the top results",
    },
    {
      tool: "get_callers",
      args: { ...address, relativePath: anchors[0] },
      why: "files importing the top result",
    },
  ];
}

function isDocumentationRow(payload: Record<string, unknown> | undefined): boolean {
  if (payload?.isDocumentation === true) return true;
  const { language } = payload ?? {};
  return typeof language === "string" && DOCUMENTATION_LANGUAGES.has(language);
}
