/**
 * Code indexing tools registration — thin wrappers delegating to App.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App, SchemaBuilder } from "../../core/api/index.js";
import { appendDriftWarning, formatMcpError, formatMcpText, sanitizeRerank } from "../format.js";
import { formatEnrichmentStatus } from "./formatters/enrichment.js";
import { createSearchSchemas } from "./schemas.js";
import * as schemas from "./schemas.js";

export function registerCodeTools(server: McpServer, deps: { app: App; schemaBuilder: SchemaBuilder }): void {
  const { app } = deps;
  const searchSchemas = createSearchSchemas(deps.schemaBuilder);

  // index_codebase
  server.registerTool(
    "index_codebase",
    {
      title: "Index Codebase",
      description:
        "Index a codebase for semantic code search. Automatically discovers files, chunks code intelligently using AST-aware parsing, and stores in vector database. Respects .gitignore and other ignore files.\n\n" +
        "GIT METADATA: Set CODE_ENABLE_GIT_METADATA=true environment variable before indexing to enable git blame analysis. " +
        "This adds author, dates, commit history, and task IDs to each code chunk, enabling powerful filters in search_code:\n" +
        "- Filter by author (who wrote this code?)\n" +
        "- Filter by age (recent vs legacy code)\n" +
        "- Filter by churn (frequently changed code)\n" +
        "- Filter by task/ticket IDs (JIRA, GitHub issues, etc.)",
      inputSchema: schemas.IndexCodebaseSchema,
    },
    async ({ path, forceReindex, extensions, ignorePatterns }) => {
      try {
        const stats = await app.indexCodebase(path, { forceReindex, extensions, ignorePatterns }, (progress) => {
          console.error(`[${progress.phase}] ${progress.percentage}% - ${progress.message}`);
        });

        let statusMessage = `Indexed ${stats.filesIndexed}/${stats.filesScanned} files (${stats.chunksCreated} chunks) in ${(stats.durationMs / 1000).toFixed(1)}s`;

        const enrichmentMessage = await formatEnrichmentStatus(
          stats.enrichmentStatus,
          stats.enrichmentDurationMs,
          async (p) => app.getIndexStatus(p),
          path,
        );
        statusMessage += enrichmentMessage;

        if (stats.status === "partial") {
          statusMessage += `\n\nWarnings:\n${stats.errors?.join("\n")}`;
        } else if (stats.status === "failed") {
          statusMessage = `Indexing failed:\n${stats.errors?.join("\n")}`;
        }

        return {
          content: [{ type: "text" as const, text: statusMessage }],
          isError: stats.status === "failed",
        };
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // search_code
  server.registerTool(
    "search_code",
    {
      title: "Search Code",
      description:
        "Search indexed codebase using natural language queries. Returns semantically relevant code chunks with file paths and line numbers. " +
        "Supports filtering by file types, path patterns, and git metadata (dominant author, date range, code age, churn/commit count, task IDs). " +
        "Git filters require CODE_ENABLE_GIT_METADATA=true during indexing. Task IDs (e.g., TD-1234, #567) are extracted from commit summaries.\n\n" +
        "GIT METADATA USE CASES:\n" +
        "- 'author': Find code by specific developer (code review, ownership questions, onboarding)\n" +
        "- 'maxAgeDays': Find recent changes (sprint review, incident response, what changed recently?)\n" +
        "- 'minAgeDays': Find legacy/old code (tech debt, needs documentation, refactoring candidates)\n" +
        "- 'minCommitCount': Find high-churn code (problematic areas, frequently modified, risk assessment)\n" +
        "- 'taskId': Trace code to requirements (impact analysis, audit, what was done for ticket X?)\n" +
        "- 'modifiedAfter/Before': Find code in date range (release analysis, historical debugging)\n\n" +
        "EXAMPLE QUERIES:\n" +
        "- 'Complex code that hasn't been touched in 30+ days' → query='complex logic', minAgeDays=30\n" +
        "- 'What did John work on last week?' → author='John', maxAgeDays=7\n" +
        "- 'High-churn authentication code' → query='authentication', minCommitCount=5\n" +
        "- 'Code related to ticket TD-1234' → taskId='TD-1234'\n" +
        "- 'Legacy code that might need documentation' → query='service', minAgeDays=60",
      inputSchema: searchSchemas.SearchCodeSchema,
    },
    async ({ rerank, ...rest }) => {
      try {
        const response = await app.searchCode({
          ...rest,
          rerank: sanitizeRerank(rerank),
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
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // reindex_changes
  server.registerTool(
    "reindex_changes",
    {
      title: "Reindex Changes",
      description:
        "Incrementally re-index only changed files. Detects added, modified, and deleted files since last index. Requires previous indexing with index_codebase.",
      inputSchema: schemas.ReindexChangesSchema,
    },
    async ({ path }) => {
      try {
        const stats = await app.reindexChanges(path, (progress) => {
          console.error(`[${progress.phase}] ${progress.percentage}% - ${progress.message}`);
        });

        let message = `Incremental re-index complete:\n`;
        message += `- Files added: ${stats.filesAdded}\n`;
        message += `- Files modified: ${stats.filesModified}\n`;
        message += `- Files deleted: ${stats.filesDeleted}\n`;
        message += `- Chunks added: ${stats.chunksAdded}\n`;
        message += `- Duration: ${(stats.durationMs / 1000).toFixed(1)}s`;

        const enrichmentMessage = await formatEnrichmentStatus(
          stats.enrichmentStatus,
          stats.enrichmentDurationMs,
          async (p) => app.getIndexStatus(p),
          path,
        );
        message += enrichmentMessage;

        if (stats.filesAdded === 0 && stats.filesModified === 0 && stats.filesDeleted === 0) {
          message = `No changes detected. Codebase is up to date.`;
        }

        const driftWarning = await app.checkSchemaDrift({ path });
        return appendDriftWarning(formatMcpText(message), driftWarning);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // get_index_status
  server.registerTool(
    "get_index_status",
    {
      title: "Get Index Status",
      description:
        "Get indexing status and statistics for a codebase. " +
        "When CODE_ENABLE_GIT_METADATA=true, also shows git enrichment progress " +
        "(in_progress with percentage, completed, or failed). " +
        "Git enrichment runs in the background after indexing completes — " +
        "check this tool periodically until enrichment is complete before using git-based filters or rerank presets.",
      inputSchema: schemas.GetIndexStatusSchema,
    },
    async ({ path }) => {
      try {
        const status = await app.getIndexStatus(path);

        if (status.status === "not_indexed") {
          return formatMcpText(`Codebase at "${path}" is not indexed. Use index_codebase to index it first.`);
        }

        if (status.status === "indexing") {
          let text = `Codebase at "${path}" is currently being indexed. ${status.chunksCount || 0} chunks processed so far.`;
          if (status.enrichment) {
            text += `\nGit enrichment: ${status.enrichment.status}`;
            if (status.enrichment.percentage !== undefined) {
              text += ` (${status.enrichment.percentage}%)`;
            }
          }
          return formatMcpText(text);
        }

        // Include enrichment info in the response
        const response: Record<string, unknown> = { ...status };
        if (status.enrichment) {
          response.enrichment = status.enrichment;
        }

        let text = JSON.stringify(response, null, 2);

        // Add visible enrichment status line so agents notice it
        if (status.enrichment?.status === "in_progress") {
          const pct = status.enrichment.percentage ?? 0;
          text += `\n\n⏳ Git enrichment is still running (${pct}% — ${status.enrichment.processedFiles ?? 0}/${status.enrichment.totalFiles ?? "?"} files). Git-based filters and rerank presets will not work until enrichment completes.`;
        }

        const driftWarning = await app.checkSchemaDrift({ path });
        return appendDriftWarning(formatMcpText(text), driftWarning);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // clear_index
  server.registerTool(
    "clear_index",
    {
      title: "Clear Index",
      description:
        "Delete all indexed data for a codebase. This is irreversible and will remove the entire collection.",
      inputSchema: schemas.ClearIndexSchema,
    },
    async ({ path }) => {
      try {
        await app.clearIndex(path);
        return formatMcpText(`Index cleared for codebase at "${path}".`);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
