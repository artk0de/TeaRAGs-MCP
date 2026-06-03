/**
 * Code search tool: search_code (human-readable variant; analytical
 * variants like semantic_search/hybrid_search live in explore.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App, SchemaBuilder } from "../../../core/api/public/index.js";
import { appendDriftWarning, formatMcpText, sanitizeRerank } from "../../format.js";
import type { RegisterToolFn } from "../../middleware/error-handler.js";
import { createSearchSchemas } from "../schemas.js";

export function registerSearchTools(
  server: McpServer,
  deps: { app: App; schemaBuilder: SchemaBuilder; register: RegisterToolFn },
): void {
  const { app, register: registerToolSafe } = deps;
  const searchSchemas = createSearchSchemas(deps.schemaBuilder);

  // search_code
  registerToolSafe(
    server,
    "search_code",
    {
      title: "Search Code",
      description:
        "Quick semantic search for user requests. Human-readable output with code snippets and line numbers. " +
        "Supports file type, path pattern, and git metadata filters.\n\n" +
        "For examples see tea-rags://schema/search-guide\n" +
        "For parameter docs see tea-rags://schema/overview",
      inputSchema: searchSchemas.SearchCodeSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ rerank, ...rest }) => {
      const response = await app.searchCode({
        ...rest,
        rerank: sanitizeRerank(rerank as string | { custom: Record<string, number | undefined> } | undefined),
      });

      if (response.results.length === 0) {
        return formatMcpText(`No results found for query: "${rest.query}"`);
      }

      // Format ExploreResult payload → human-readable text (MCP layer responsibility)
      const formattedResults = response.results
        .map((r, idx) => {
          const p = r.payload ?? {};
          const file = typeof p.relativePath === "string" ? p.relativePath : "unknown";
          const startLine = typeof p.startLine === "number" ? p.startLine : 0;
          const endLine = typeof p.endLine === "number" ? p.endLine : 0;
          const lang = typeof p.language === "string" ? p.language : "unknown";
          const content = typeof p.content === "string" ? p.content : "";

          return (
            `\n--- Result ${idx + 1} (score: ${r.score.toFixed(3)}) ---\n` +
            `File: ${file}:${startLine}-${endLine}\n` +
            `Language: ${lang}\n\n` +
            `${content}\n`
          );
        })
        .join("\n");

      const text = `Found ${response.results.length} result(s):\n${formattedResults}`;
      return appendDriftWarning(formatMcpText(text), response.driftWarning);
    },
  );
}
