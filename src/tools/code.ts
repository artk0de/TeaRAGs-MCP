/**
 * Code indexing tools registration
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CodeIndexer } from "../code/indexer.js";
import * as schemas from "./schemas.js";

export interface CodeToolDependencies {
  codeIndexer: CodeIndexer;
}

export function registerCodeTools(server: McpServer, deps: CodeToolDependencies): void {
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
      const stats = await codeIndexer.indexCodebase(path, { forceReindex, extensions, ignorePatterns }, (progress) => {
        // Progress callback - could send progress updates via SSE in future
        console.error(`[${progress.phase}] ${progress.percentage}% - ${progress.message}`);
      });

      let statusMessage = `Indexed ${stats.filesIndexed}/${stats.filesScanned} files (${stats.chunksCreated} chunks) in ${(stats.durationMs / 1000).toFixed(1)}s`;

      if (stats.enrichmentStatus === "background") {
        // Fetch current enrichment progress from Qdrant
        try {
          const currentStatus = await codeIndexer.getIndexStatus(path);
          if (currentStatus.enrichment) {
            const e = currentStatus.enrichment;
            statusMessage += `\n\nGit enrichment: ${e.status}`;
            if (e.percentage !== undefined) statusMessage += ` (${e.percentage}%)`;
            if (e.matchedFiles !== undefined && e.missedFiles !== undefined) {
              const total = e.matchedFiles + e.missedFiles;
              const rate = total > 0 ? Math.round((e.matchedFiles / total) * 100) : 0;
              statusMessage += `\nGit metadata coverage: ${rate}% (${e.matchedFiles}/${total} indexed files)`;
              if (e.gitLogFileCount !== undefined) {
                statusMessage += `\nGit log contains ${e.gitLogFileCount} files (GIT_LOG_MAX_AGE_MONTHS window)`;
              }
              if (rate < 80 && e.missedFiles > 0) {
                statusMessage += `\nHint: Low coverage is normal for mature codebases. Increase GIT_LOG_MAX_AGE_MONTHS for broader coverage.`;
              }
            }
            if (e.status !== "completed") {
              statusMessage += `\n[Use get_index_status to track progress.]`;
            }
          } else {
            statusMessage += `\n\n[Git enrichment is running in background. Use get_index_status to track progress.]`;
          }
        } catch {
          statusMessage += `\n\n[Git enrichment is running in background. Use get_index_status to track progress.]`;
        }
      } else if (stats.enrichmentStatus && stats.enrichmentStatus !== "skipped") {
        statusMessage += `\nGit enrichment: ${stats.enrichmentStatus}`;
        if (stats.enrichmentDurationMs) {
          statusMessage += ` (${(stats.enrichmentDurationMs / 1000).toFixed(1)}s)`;
        }
      }

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
      rerank,
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
        rerank,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for query: "${query}"` }],
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
        console.error(`[${progress.phase}] ${progress.percentage}% - ${progress.message}`);
      });

      let message = `Incremental re-index complete:\n`;
      message += `- Files added: ${stats.filesAdded}\n`;
      message += `- Files modified: ${stats.filesModified}\n`;
      message += `- Files deleted: ${stats.filesDeleted}\n`;
      message += `- Chunks added: ${stats.chunksAdded}\n`;
      message += `- Duration: ${(stats.durationMs / 1000).toFixed(1)}s`;

      if (stats.enrichmentStatus === "background") {
        // Fetch current enrichment progress from Qdrant
        try {
          const currentStatus = await codeIndexer.getIndexStatus(path);
          if (currentStatus.enrichment) {
            const e = currentStatus.enrichment;
            message += `\n\nGit enrichment: ${e.status}`;
            if (e.percentage !== undefined) message += ` (${e.percentage}%)`;
            if (e.matchedFiles !== undefined && e.missedFiles !== undefined) {
              const total = e.matchedFiles + e.missedFiles;
              const rate = total > 0 ? Math.round((e.matchedFiles / total) * 100) : 0;
              message += `\nGit metadata coverage: ${rate}% (${e.matchedFiles}/${total} indexed files)`;
              if (e.gitLogFileCount !== undefined) {
                message += `\nGit log contains ${e.gitLogFileCount} files (GIT_LOG_MAX_AGE_MONTHS window)`;
              }
              if (rate < 80 && e.missedFiles > 0) {
                message += `\nHint: Low coverage is normal for mature codebases. Increase GIT_LOG_MAX_AGE_MONTHS for broader coverage.`;
              }
            }
            if (e.status !== "completed") {
              message += `\n[Use get_index_status to track progress.]`;
            }
          } else {
            message += `\n\n[Git enrichment is running in background. Use get_index_status to track progress.]`;
          }
        } catch {
          message += `\n\n[Git enrichment is running in background. Use get_index_status to track progress.]`;
        }
      } else if (stats.enrichmentStatus && stats.enrichmentStatus !== "skipped") {
        message += `\n- Git enrichment: ${stats.enrichmentStatus}`;
        if (stats.enrichmentDurationMs) {
          message += ` (${(stats.enrichmentDurationMs / 1000).toFixed(1)}s)`;
        }
      }

      if (stats.filesAdded === 0 && stats.filesModified === 0 && stats.filesDeleted === 0) {
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
      description:
        "Get indexing status and statistics for a codebase. " +
        "When CODE_ENABLE_GIT_METADATA=true, also shows git enrichment progress " +
        "(in_progress with percentage, completed, or failed). " +
        "Git enrichment runs in the background after indexing completes — " +
        "check this tool periodically until enrichment is complete before using git-based filters or rerank presets.",
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
        let text = `Codebase at "${path}" is currently being indexed. ${status.chunksCount || 0} chunks processed so far.`;
        if (status.enrichment) {
          text += `\nGit enrichment: ${status.enrichment.status}`;
          if (status.enrichment.percentage !== undefined) {
            text += ` (${status.enrichment.percentage}%)`;
          }
        }
        return {
          content: [{ type: "text", text }],
        };
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

      return {
        content: [{ type: "text", text }],
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
        content: [{ type: "text", text: `Index cleared for codebase at "${path}".` }],
      };
    },
  );
}
