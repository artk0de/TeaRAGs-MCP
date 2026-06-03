/**
 * Index lifecycle tools: index_codebase, reindex_changes.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App } from "../../../core/api/public/index.js";
import { appendDriftWarning, formatMcpText } from "../../format.js";
import type { RegisterToolFn } from "../../middleware/error-handler.js";
import { formatEnrichmentStatus } from "../formatters/enrichment.js";
import * as schemas from "../schemas.js";
import { resolvePathFromProject } from "./shared.js";

export function registerIndexTools(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  const { app, register: registerToolSafe } = deps;

  // index_codebase
  registerToolSafe(
    server,
    "index_codebase",
    {
      title: "Index Codebase",
      description:
        "Index a codebase for semantic code search. AST-aware chunking, respects .gitignore. " +
        "Set CODE_ENABLE_GIT_METADATA=true for git blame analysis.\n\n" +
        "For indexing options and git metadata guide see tea-rags://schema/indexing-guide",
      inputSchema: schemas.IndexCodebaseSchema,
      annotations: { idempotentHint: true },
    },
    async ({ path: pathArg, project, forceReindex, extensions, ignorePatterns }) => {
      const path = await resolvePathFromProject({ path: pathArg, project }, app);
      const stats = await app.indexCodebase(path, { forceReindex, extensions, ignorePatterns }, (progress) => {
        console.error(`[${progress.phase}] ${progress.percentage}% - ${progress.message}`);
      });

      let statusMessage: string;
      if (stats.changeDetails) {
        const d = stats.changeDetails;
        if (d.filesAdded === 0 && d.filesModified === 0 && d.filesDeleted === 0) {
          statusMessage = `No changes detected. Codebase is up to date.`;
        } else {
          statusMessage = `Incremental re-index complete:\n`;
          statusMessage += `- Files: +${d.filesAdded} ~${d.filesModified} -${d.filesDeleted}\n`;
          if (d.filesNewlyIgnored > 0) statusMessage += `  Newly ignored: ${d.filesNewlyIgnored}\n`;
          if (d.filesNewlyUnignored > 0) statusMessage += `  Newly unignored: ${d.filesNewlyUnignored}\n`;
          const chunkDiff = d.chunksAdded - d.chunksDeleted;
          const sign = chunkDiff >= 0 ? "+" : "";
          statusMessage += `- Chunks: +${d.chunksAdded} -${d.chunksDeleted} (net: ${sign}${chunkDiff})\n`;
          statusMessage += `- Duration: ${(stats.durationMs / 1000).toFixed(1)}s`;
        }
      } else {
        statusMessage = `Indexed ${stats.filesIndexed}/${stats.filesScanned} files (${stats.chunksCreated} chunks) in ${(stats.durationMs / 1000).toFixed(1)}s`;
      }

      const enrichmentMessage = await formatEnrichmentStatus(
        stats.enrichmentStatus,
        stats.enrichmentDurationMs,
        async (p) => app.getIndexStatus(p),
        path,
        stats.enrichmentMetrics,
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
    },
  );

  // reindex_changes (deprecated — use index_codebase which auto-detects)
  registerToolSafe(
    server,
    "reindex_changes",
    {
      title: "Reindex Changes",
      description:
        "Deprecated: use index_codebase instead — it automatically detects changes and does incremental reindex.\n\n" +
        "Incrementally re-index only changed files. Detects added, modified, and deleted files since last index. Requires previous indexing with index_codebase.",
      inputSchema: schemas.ReindexChangesSchema,
      annotations: { idempotentHint: true },
    },
    async ({ path: pathArg, project }) => {
      const path = await resolvePathFromProject({ path: pathArg, project }, app);
      const stats = await app.reindexChanges(path, (progress) => {
        console.error(`[${progress.phase}] ${progress.percentage}% - ${progress.message}`);
      });

      let message = `Incremental re-index complete:\n`;
      message += `- Files: +${stats.filesAdded} ~${stats.filesModified} -${stats.filesDeleted}\n`;
      if (stats.filesNewlyIgnored > 0) {
        message += `  Newly ignored: ${stats.filesNewlyIgnored}\n`;
      }
      if (stats.filesNewlyUnignored > 0) {
        message += `  Newly unignored: ${stats.filesNewlyUnignored}\n`;
      }
      const chunkDiff = stats.chunksAdded - stats.chunksDeleted;
      const sign = chunkDiff >= 0 ? "+" : "";
      message += `- Chunks: +${stats.chunksAdded} -${stats.chunksDeleted} (net: ${sign}${chunkDiff})\n`;
      message += `- Duration: ${(stats.durationMs / 1000).toFixed(1)}s`;

      const enrichmentMessage = await formatEnrichmentStatus(
        stats.enrichmentStatus,
        stats.enrichmentDurationMs,
        async (p) => app.getIndexStatus(p),
        path,
        stats.enrichmentMetrics,
      );
      message += enrichmentMessage;

      if (stats.filesAdded === 0 && stats.filesModified === 0 && stats.filesDeleted === 0) {
        message = `No changes detected. Codebase is up to date.`;
      }

      const driftWarning = await app.checkSchemaDrift({ path });
      return appendDriftWarning(formatMcpText(message), driftWarning);
    },
  );
}
