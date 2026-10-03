/**
 * Shared MCP response formatters.
 * All MCP tool handlers use these to format responses.
 */

import type { WorkingTreeMarker, WorkingTreeState } from "../core/api/public/dto/working-tree.js";

export interface McpToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function formatMcpResponse(data: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function formatMcpText(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

export function formatMcpError(message: string): McpToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * Sanitize rerank param from Zod schema (custom values may be undefined) to App-compatible type.
 */
export function sanitizeRerank(
  rerank: string | { custom: Record<string, number | undefined> } | undefined,
): string | { custom: Record<string, number> } | undefined {
  if (!rerank || typeof rerank === "string") return rerank;
  const cleaned: Record<string, number> = {};
  for (const [k, v] of Object.entries(rerank.custom)) {
    if (typeof v === "number") cleaned[k] = v;
  }
  return { custom: cleaned };
}

export function appendDriftWarning(result: McpToolResult, warning: string | null): McpToolResult {
  if (!warning || result.content.length === 0) return result;
  const last = result.content[result.content.length - 1];
  last.text += `\n\n${warning}`;
  return result;
}

/**
 * One-line text render of the `workingTree` marker (bd tea-rags-mcp-xi2r9) for
 * the text-output tools; structured tools carry the object itself.
 */
export function formatWorkingTreeMarker(marker: WorkingTreeMarker): string {
  const sha = (commit: string | null): string => (commit ? commit.slice(0, 7) : "none");
  const floors = marker.floors.length > 0 ? marker.floors.join(",") : "none";
  const treeGraph = marker.treeGraphUnavailable ? ` · tree graph unavailable: ${marker.treeGraphUnavailable}` : "";
  const dense = marker.denseUnavailable ? ` · dense unavailable: ${marker.denseUnavailable.reason}` : "";
  const indexOnly = marker.indexOnlyFiles ? ` (${marker.indexOnlyFiles} index-only)` : "";
  const line =
    `workingTree: ${marker.tree} · index @${sha(marker.indexedCommit)} · tree @${sha(marker.treeCommit)}` +
    ` · changed ${marker.changedFiles}${indexOnly} · deleted ${marker.deletedFiles} · floors ${floors}${treeGraph}${dense}`;
  return marker.degraded ? `${line} · degraded: ${marker.degraded.reason} → ${marker.degraded.remedy}` : line;
}

/**
 * The text tag of a result whose file the tree changed or deleted (bd
 * tea-rags-mcp-xi2r9, live probe P2-5). A text tool has no `treeState` key for
 * the reader to notice, so the result line itself says the content shown is
 * the INDEX copy, not the tree's.
 */
export function formatWorkingTreeStateTag(treeState: WorkingTreeState | undefined): string {
  return treeState ? ` [${treeState} in tree — index copy]` : "";
}

/** Footer list bound: the marker line already carries the full counts. */
const TOUCHED_FILES_LISTED = 10;

/**
 * Footer line naming each file of the answer the tree touched, once, in result
 * order — first {@link TOUCHED_FILES_LISTED}, then "… N more". Empty when no
 * result belongs to a touched file. Scoped to the ANSWER's files: the marker
 * counts the whole delta, and a reader acts on the files it was shown.
 */
export function formatWorkingTreeTouchedFiles(
  results: readonly { treeState?: WorkingTreeState; payload?: Record<string, unknown> }[],
): string {
  const touched = new Map<string, WorkingTreeState>();
  for (const { treeState, payload } of results) {
    const file = payload?.relativePath;
    if (treeState && typeof file === "string" && !touched.has(file)) touched.set(file, treeState);
  }
  if (touched.size === 0) return "";
  const listed = [...touched]
    .slice(0, TOUCHED_FILES_LISTED)
    .map(([file, state]) => `${file} (${state})`)
    .join(", ");
  const more = touched.size > TOUCHED_FILES_LISTED ? ` … ${String(touched.size - TOUCHED_FILES_LISTED)} more` : "";
  return `Index copies of files the tree touched: ${listed}${more}`;
}

/**
 * Append auto-update hint (hpg2) as its own text entry. Unlike
 * appendDriftWarning it works on structuredContent results whose `content`
 * is empty — the hint becomes the sole text entry. Null hint = no-op.
 */
export function appendAutoUpdateHint(result: McpToolResult, hint: string | null): McpToolResult {
  if (!hint) return result;
  result.content.push({ type: "text", text: hint });
  return result;
}
