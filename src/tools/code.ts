/**
 * Code indexing tools registration
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodeIndexer } from "../code/indexer.js";
import * as schemas from "./schemas.js";

export interface CodeToolDependencies {
  codeIndexer: CodeIndexer;
}

export function registerCodeTools(
  server: McpServer,
  deps: CodeToolDependencies,
): void {
  const { codeIndexer } = deps;

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
      const stats = await codeIndexer.indexCodebase(
        path,
        { forceReindex, extensions, ignorePatterns },
        (progress) => {
          // Progress callback - could send progress updates via SSE in future
          console.error(
            `[${progress.phase}] ${progress.percentage}% - ${progress.message}`,
          );
        },
      );

      let statusMessage = `Indexed ${stats.filesIndexed}/${stats.filesScanned} files (${stats.chunksCreated} chunks) in ${(stats.durationMs / 1000).toFixed(1)}s`;

      if (stats.status === "partial") {
        statusMessage += `\n\nWarnings:\n${stats.errors?.join("\n")}`;
      } else if (stats.status === "failed") {
        statusMessage = `Indexing failed:\n${stats.errors?.join("\n")}`;
      }

      return {
        content: [{ type: "text", text: statusMessage }],
        isError: stats.status === "failed",
      };
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
      inputSchema: schemas.SearchCodeSchema,
    },
    async ({
      path,
      query,
      limit,
      fileTypes,
      pathPattern,
      documentationOnly,
      author,
      modifiedAfter,
      modifiedBefore,
      minAgeDays,
      maxAgeDays,
      minCommitCount,
      taskId,
    }) => {
      const results = await codeIndexer.searchCode(path, query, {
        limit,
        fileTypes,
        pathPattern,
        documentationOnly,
        author,
        modifiedAfter,
        modifiedBefore,
        minAgeDays,
        maxAgeDays,
        minCommitCount,
        taskId,
      });

      if (results.length === 0) {
        return {
          content: [
            { type: "text", text: `No results found for query: "${query}"` },
          ],
        };
      }

      // Format results with file references
      const formattedResults = results
        .map(
          (r, idx) =>
            `\n--- Result ${idx + 1} (score: ${r.score.toFixed(3)}) ---\n` +
            `File: ${r.filePath}:${r.startLine}-${r.endLine}\n` +
            `Language: ${r.language}\n\n` +
            `${r.content}\n`,
        )
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} result(s):\n${formattedResults}`,
          },
        ],
      };
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
      const stats = await codeIndexer.reindexChanges(path, (progress) => {
        console.error(
          `[${progress.phase}] ${progress.percentage}% - ${progress.message}`,
        );
      });

      let message = `Incremental re-index complete:\n`;
      message += `- Files added: ${stats.filesAdded}\n`;
      message += `- Files modified: ${stats.filesModified}\n`;
      message += `- Files deleted: ${stats.filesDeleted}\n`;
      message += `- Chunks added: ${stats.chunksAdded}\n`;
      message += `- Duration: ${(stats.durationMs / 1000).toFixed(1)}s`;

      if (
        stats.filesAdded === 0 &&
        stats.filesModified === 0 &&
        stats.filesDeleted === 0
      ) {
        message = `No changes detected. Codebase is up to date.`;
      }

      return {
        content: [{ type: "text", text: message }],
      };
    },
  );

  // get_index_status
  server.registerTool(
    "get_index_status",
    {
      title: "Get Index Status",
      description: "Get indexing status and statistics for a codebase.",
      inputSchema: schemas.GetIndexStatusSchema,
    },
    async ({ path }) => {
      const status = await codeIndexer.getIndexStatus(path);

      if (status.status === "not_indexed") {
        return {
          content: [
            {
              type: "text",
              text: `Codebase at "${path}" is not indexed. Use index_codebase to index it first.`,
            },
          ],
        };
      }

      if (status.status === "indexing") {
        return {
          content: [
            {
              type: "text",
              text: `Codebase at "${path}" is currently being indexed. ${status.chunksCount || 0} chunks processed so far.`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
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
      await codeIndexer.clearIndex(path);
      return {
        content: [
          { type: "text", text: `Index cleared for codebase at "${path}".` },
        ],
      };
    },
  );

}
