/**
 * Shared MCP response formatters.
 * All MCP tool handlers use these to format responses.
 */

import type { WorkingTreeMarker } from "../core/api/public/dto/working-tree.js";

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
  const line =
    `workingTree: ${marker.tree} · index @${sha(marker.indexedCommit)} · tree @${sha(marker.treeCommit)}` +
    ` · changed ${marker.changedFiles} · deleted ${marker.deletedFiles} · floors ${floors}`;
  return marker.degraded ? `${line} · degraded: ${marker.degraded.reason} → ${marker.degraded.remedy}` : line;
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
