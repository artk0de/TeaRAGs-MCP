/**
 * Answer banners (bd tea-rags-mcp-nknkg.3) — a one-line imperative placed as
 * the FIRST text content item of a tool answer, before the answer data.
 *
 * Measured 2026-10-28 (Codex ×12 per variant, plan-only cases quoting a tool
 * answer): the same text as a trailing JSON field barely moves the next call
 * (3/6) and a state-fact line does nothing, while a leading imperative does
 * (search rows → graph: 4/12 without, 11/12 with). Naming row 1 as the anchor
 * is harmful when the right anchor is lower, so the search banner never names
 * a concrete row.
 *
 * Banners fire at three decision points only — search rows, empty graph
 * answers for a symbol, find_symbol bodies — and never on errors. A structured
 * answer also carries the banner as its FIRST key, `banner`: Claude Code hands
 * the model `structuredContent` instead of `content` when both exist (live,
 * 2026-10-28), so a content-only banner never reached it there.
 */
import { foldColumnTables } from "./columns.js";
import type { McpToolResult } from "./format.js";
import { readAnswer } from "./response-budget.js";

const BANNER_PREFIX = "↳ ";

export const SEARCH_ANCHOR_BANNER =
  `${BANNER_PREFIX}Anchor = the row whose symbol names the asked behaviour (any row, not row 1) → ` +
  "get_callees(symbolId: <anchor>, depth: 2) → ONE find_symbol(symbols:[needed ids]).";

export const BODY_SHOWN_BANNER = `${BANNER_PREFIX}Body shown in full — answer from it; do not reopen the file.`;

/** "default code search tool" is plugin vocabulary: the Codex/Cursor transforms map it to the host's tool. */
export function emptyGraphBanner(tool: GraphBannerTool, shortName: string): string {
  const edgeNoun = tool === "get_callers" ? "callers" : "callees";
  return (
    `${BANNER_PREFIX}Empty ≠ no ${edgeNoun}: dynamic/DSL/job call sites are not in the graph — ` +
    `default code search tool "${shortName}" <src dir> (literal, -l) before concluding.`
  );
}

/** The bare member name a literal search finds: `Mod::Class#m?` → `m?`, `Class.m` → `m`, `fn` → `fn`. */
export function symbolShortName(symbolId: string): string {
  const segments = symbolId.split(/#|::|\./).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? symbolId;
}

const SEARCH_ROW_TOOLS: ReadonlySet<string> = new Set([
  "semantic_search",
  "hybrid_search",
  "rank_chunks",
  "find_similar",
]);
const GRAPH_BANNER_TOOLS = ["get_callers", "get_callees"] as const;
type GraphBannerTool = (typeof GRAPH_BANNER_TOOLS)[number];

/** The banner a tool answer opens with, or undefined when the answer is not a decision point. */
export function answerBannerFor(tool: string, args: unknown, result: McpToolResult): string | undefined {
  if (result.isError === true) return undefined;
  const read = readAnswer(result);
  if (!read) return undefined;
  const request = isRecord(args) ? args : {};
  if (SEARCH_ROW_TOOLS.has(tool)) return resultRows(read.answer).some(hasSymbolId) ? SEARCH_ANCHOR_BANNER : undefined;
  if (tool === "find_symbol") return findSymbolBanner(request, read.answer);
  if (isGraphBannerTool(tool)) return emptyGraphBannerFor(tool, request, read.answer);
  return undefined;
}

/**
 * Wraps a tool handler so its answer opens with the banner {@link answerBannerFor} picks:
 * the first content item AND, on a structured answer, the first `structuredContent` key
 * (`banner`) — Claude Code shows the model structuredContent instead of content.
 */
export function withAnswerBanner<A, E>(
  tool: string,
  handler: (args: A, extra: E) => Promise<McpToolResult>,
): (args: A, extra: E) => Promise<McpToolResult> {
  return async (args, extra) => {
    const result = await handler(args, extra);
    const banner = answerBannerFor(tool, args, result);
    if (banner === undefined) return result;
    const content = [{ type: "text" as const, text: banner }, ...result.content];
    const structured = result.structuredContent;
    return isRecord(structured)
      ? { ...result, content, structuredContent: { banner, ...structured } }
      : { ...result, content };
  };
}

function findSymbolBanner(request: Record<string, unknown>, answer: Record<string, unknown>): string | undefined {
  if (request.relativePath !== undefined || request.metaOnly === true) return undefined;
  return resultRows(answer).some(isBodyRow) ? BODY_SHOWN_BANNER : undefined;
}

function emptyGraphBannerFor(
  tool: GraphBannerTool,
  request: Record<string, unknown>,
  answer: Record<string, unknown>,
): string | undefined {
  if (typeof request.symbolId !== "string" || !isRecord(answer.empty)) return undefined;
  const { reason, suggestions } = answer.empty;
  const hasSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
  const graphSaysNothing = reason === "noEdges" || (reason === "unknownSymbol" && !hasSuggestions);
  return graphSaysNothing ? emptyGraphBanner(tool, symbolShortName(request.symbolId)) : undefined;
}

/**
 * A row carrying a symbol's own code. Outlines open with a header line naming
 * the container (`ExploreFacade`, the queried id, or the file path) and list
 * member ids; a body opens with its declaration (`def m`, `async m(`).
 */
function isBodyRow(row: Record<string, unknown>): boolean {
  const payload = payloadOf(row);
  const { symbolId, content } = payload;
  if (typeof symbolId !== "string" || symbolId.startsWith("doc:") || typeof content !== "string") return false;
  if (payload.kind === "file") return false;
  const header = content.split("\n", 1)[0].trim();
  return header !== symbolId && !symbolId.endsWith(`::${header}`) && !symbolId.endsWith(`.${header}`);
}

function hasSymbolId(row: Record<string, unknown>): boolean {
  return typeof payloadOf(row).symbolId === "string";
}

function resultRows(answer: Record<string, unknown>): Record<string, unknown>[] {
  const rows = foldColumnTables(answer.results);
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
}

function payloadOf(row: Record<string, unknown>): Record<string, unknown> {
  return isRecord(row.payload) ? row.payload : {};
}

function isGraphBannerTool(tool: string): tool is GraphBannerTool {
  return (GRAPH_BANNER_TOOLS as readonly string[]).includes(tool);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a content text that is an answer banner, not answer data — readers that want the answer skip it. */
export function isAnswerBanner(text: string): boolean {
  return text.startsWith(BANNER_PREFIX);
}
