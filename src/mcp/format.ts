/**
 * Shared MCP response formatters.
 * All MCP tool handlers use these to format responses.
 */

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
