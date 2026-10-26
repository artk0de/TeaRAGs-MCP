/**
 * Shared MCP response formatters.
 * All MCP tool handlers use these to format responses.
 */

import type { WorkingTreeMarker, WorkingTreeState } from "../public/dto/working-tree.js";
import { tabulateRecordArrays } from "./columns.js";

export interface McpToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * Compact JSON; every array of two or more records goes out as a ColumnTable,
 * and a clean `workingTree` marker goes out compact.
 */
export function formatMcpResponse(data: unknown): McpToolResult {
  return {
    content: [
      { type: "text", text: makeStrictJsonSafe(JSON.stringify(tabulateRecordArrays(withCompactWorkingTree(data)))) },
    ],
  };
}

/**
 * The marker of a clean answer on the MCP output (bd tea-rags-mcp-45kbu): the
 * tree, its alias, and `changedFiles: 0` — the agent rules read that zero as
 * "measured clean", so it stays explicit.
 */
export interface CompactWorkingTreeMarker {
  tree: string;
  project?: string;
  changedFiles: 0;
}

/**
 * True when the answer's tree matches its index and no layer fell back: no
 * changed or deleted file, and none of the qualifiers that tell the reader to
 * act is present.
 */
function isCleanWorkingTreeMarker(marker: WorkingTreeMarker): boolean {
  return (
    marker.changedFiles === 0 &&
    marker.deletedFiles === 0 &&
    marker.degraded === undefined &&
    marker.pendingFiles === undefined &&
    marker.indexOnlyFiles === undefined &&
    marker.unparsed === undefined &&
    marker.treeGraphUnavailable === undefined &&
    marker.denseUnavailable === undefined &&
    marker.gitUnavailable === undefined
  );
}

/**
 * The marker as the MCP output carries it: compact when clean, else the full
 * marker unchanged. The domain marker is never mutated — internal consumers
 * keep every field; only the wire form is shortened.
 */
export function compactWorkingTreeMarker(marker: WorkingTreeMarker): WorkingTreeMarker | CompactWorkingTreeMarker {
  if (!isCleanWorkingTreeMarker(marker)) return marker;
  return { tree: marker.tree, ...(marker.project !== undefined && { project: marker.project }), changedFiles: 0 };
}

/** A top-level `workingTree` marker of an answer DTO, compacted; anything else as is. */
function withCompactWorkingTree(data: unknown): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
  const { workingTree } = data as { workingTree?: unknown };
  if (!isWorkingTreeMarker(workingTree)) return data;
  return { ...data, workingTree: compactWorkingTreeMarker(workingTree) };
}

function isWorkingTreeMarker(value: unknown): value is WorkingTreeMarker {
  if (typeof value !== "object" || value === null) return false;
  const marker = value as Partial<WorkingTreeMarker>;
  return (
    typeof marker.tree === "string" &&
    typeof marker.changedFiles === "number" &&
    typeof marker.deletedFiles === "number"
  );
}

export function formatMcpText(text: string): McpToolResult {
  return { content: [{ type: "text", text: makeStrictJsonSafe(text) }] };
}

/**
 * C0 control chars that are never legal unescaped anywhere in a JSON document:
 * inside strings they break strict parsers, and outside strings only the JSON
 * whitespace chars (\t \n \r) are legal. `JSON.stringify` output can never
 * carry them, so their presence marks hand-assembled text.
 */
// Detecting control chars IS this module's job — the rule targets accidental ones.
// eslint-disable-next-line no-control-regex
const RAW_WIRE_UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const JSON_WHITESPACE = /[\t\n\r]/;

/**
 * Make response text safe for strict JSON consumers (bd tea-rags-mcp-89k7k.21).
 *
 * The ONE serialization boundary every MCP tool response passes through —
 * `formatMcpText` forwards pre-built text verbatim, and several handlers
 * assemble text AFTER a `JSON.stringify` call, so a raw control character in
 * file-derived evidence (import specifiers, commit messages, composite keys)
 * reached the wire unescaped and broke jq / python json.load / JSON.parse.
 *
 * Escapes raw C0 control chars found INSIDE string literals; anything outside
 * string literals (pretty-print indentation, appended plain-text sections) is
 * left untouched. Already-escaped sequences (`\u000b`, `\\`) are recognized
 * and preserved. Clean text — the overwhelmingly common case — comes back
 * byte-identical.
 */
export function makeStrictJsonSafe(text: string): string {
  if (!RAW_WIRE_UNSAFE.test(text) && !JSON_WHITESPACE.test(text)) return text;
  return escapeRawControlCharsInStrings(text);
}

/** The JSON short escapes, else the `\uXXXX` form strict parsers accept. */
function controlEscape(code: number): string {
  switch (code) {
    case 0x08:
      return "\\b";
    case 0x09:
      return "\\t";
    case 0x0a:
      return "\\n";
    case 0x0c:
      return "\\f";
    case 0x0d:
      return "\\r";
    default:
      return `\\u${code.toString(16).padStart(4, "0")}`;
  }
}

/**
 * Single pass tracking in-string state: a backslash skips the escaped char, a
 * quote toggles, a raw control char inside a string is escaped. Rebuilds the
 * string only when a mutation actually happened — clean text returns as-is.
 */
function escapeRawControlCharsInStrings(text: string): string {
  let pieces: string[] | null = null;
  let inString = false;
  let copied = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const code = text.charCodeAt(i);
    if (!inString) {
      if (code === 0x22) inString = true; // "
      continue;
    }
    if (code === 0x5c) {
      i++; // backslash: the escaped char (quote, u, control) cannot toggle state
      continue;
    }
    if (code === 0x22) {
      inString = false; // "
      continue;
    }
    if (code < 0x20) {
      if (pieces === null) pieces = [];
      pieces.push(text.slice(copied, i), controlEscape(code));
      copied = i + 1;
    }
  }
  if (pieces === null) return text;
  pieces.push(text.slice(copied));
  return pieces.join("");
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
  const project = marker.project ? ` · project ${marker.project}` : "";
  if (isCleanWorkingTreeMarker(marker)) return `workingTree: ${marker.tree}${project} · changed 0`;
  const sha = (commit: string | null): string => (commit ? commit.slice(0, 7) : "none");
  const floors = marker.floors.length > 0 ? marker.floors.join(",") : "none";
  const treeGraph = marker.treeGraphUnavailable ? ` · tree graph unavailable: ${marker.treeGraphUnavailable}` : "";
  const dense = marker.denseUnavailable ? ` · dense unavailable: ${marker.denseUnavailable.reason}` : "";
  const git = marker.gitUnavailable ? ` · git unavailable: ${marker.gitUnavailable.reason}` : "";
  const fromIndex = [
    ...(marker.indexOnlyFiles ? [`${marker.indexOnlyFiles} index-only`] : []),
    ...(marker.pendingFiles ? [`${marker.pendingFiles} pending`] : []),
  ];
  const changedFromIndex = fromIndex.length > 0 ? ` (${fromIndex.join(", ")})` : "";
  const line =
    `workingTree: ${marker.tree}${project} · index @${sha(marker.indexedCommit)} · tree @${sha(marker.treeCommit)}` +
    ` · changed ${marker.changedFiles}${changedFromIndex} · deleted ${marker.deletedFiles} · floors ${floors}${treeGraph}${dense}${git}`;
  return marker.degraded ? `${line} · degraded: ${marker.degraded.reason} → ${marker.degraded.remedy}` : line;
}

/**
 * One-line text render of an answer's top-level `denseUnavailable`: hybrid_search
 * ranked by BM25 alone because the embedding provider could not embed the query.
 */
export function formatDenseUnavailable(denseUnavailable: { reason: string }): string {
  return `dense leg unavailable: ${denseUnavailable.reason} — ranked by BM25 only`;
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
