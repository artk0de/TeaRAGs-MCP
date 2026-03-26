/**
 * Code indexing tools registration — thin wrappers delegating to App.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App, IndexStatus, SchemaBuilder } from "../../core/api/index.js";
import { appendDriftWarning, formatMcpText, sanitizeRerank } from "../format.js";
import { registerToolSafe } from "../middleware/error-handler.js";
import { formatEnrichmentStatus } from "./formatters/enrichment.js";
import { createSearchSchemas } from "./schemas.js";
import * as schemas from "./schemas.js";

export function registerCodeTools(server: McpServer, deps: { app: App; schemaBuilder: SchemaBuilder }): void {
  const { app } = deps;
  const searchSchemas = createSearchSchemas(deps.schemaBuilder);

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
    async ({ path, forceReindex, extensions, ignorePatterns }) => {
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
    async ({ path }) => {
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

  // get_index_status
  registerToolSafe(
    server,
    "get_index_status",
    {
      title: "Get Index Status",
      description:
        "Get indexing status, statistics, and git enrichment progress for a codebase.\n\n" +
        "For indexing workflow see tea-rags://schema/indexing-guide",
      inputSchema: schemas.GetIndexStatusSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      const status = await app.getIndexStatus(path);

      if (status.status === "unavailable") {
        let text = `Infrastructure problem detected for "${path}".\n`;
        if (status.infraHealth) {
          text += formatInfraHealth(status.infraHealth);
        }
        text += `\nIndex state is unknown — Qdrant is not reachable.`;
        return formatMcpText(text);
      }

      if (status.status === "not_indexed") {
        let text = `Codebase at "${path}" is not indexed. Use index_codebase to index it first.`;
        if (status.infraHealth) text += `\n\n${formatInfraHealth(status.infraHealth)}`;
        return formatMcpText(text);
      }

      if (status.status === "stale_indexing") {
        let text =
          `Codebase at "${path}" has a stale indexing marker (started but never completed — likely crashed). ` +
          `Use index_codebase to re-index. The stale collection will be cleaned up automatically.`;
        if (status.infraHealth) text += `\n\n${formatInfraHealth(status.infraHealth)}`;
        return formatMcpText(text);
      }

      if (status.status === "indexing") {
        let text = `Codebase at "${path}" is currently being indexed. ${status.chunksCount || 0} chunks processed so far.`;
        if (status.enrichment) {
          text += `\nGit enrichment: ${status.enrichment.status}`;
          if (status.enrichment.percentage !== undefined) {
            text += ` (${status.enrichment.percentage}%)`;
          }
        }
        if (status.infraHealth) text += `\n\n${formatInfraHealth(status.infraHealth)}`;
        return formatMcpText(text);
      }

      // Regroup enrichment into trajectory.git.{file, chunk} structure
      const { enrichment, chunkEnrichment, infraHealth, ...rest } = status;
      const response: Record<string, unknown> = { ...rest };
      if (enrichment || chunkEnrichment) {
        response.trajectory = {
          git: {
            ...(enrichment ? { file: enrichment } : {}),
            ...(chunkEnrichment ? { chunk: chunkEnrichment } : {}),
          },
        };
      }

      let text = JSON.stringify(response, null, 2);

      // Add visible enrichment status line so agents notice it
      if (status.enrichment?.status === "in_progress") {
        const pct = status.enrichment.percentage ?? 0;
        text += `\n\n⏳ Git enrichment is still running (${pct}% — ${status.enrichment.processedFiles ?? 0}/${status.enrichment.totalFiles ?? "?"} files). Git-based filters and rerank presets will not work until enrichment completes.`;
      }

      if (infraHealth) text += `\n\n${formatInfraHealth(infraHealth)}`;

      const driftWarning = await app.checkSchemaDrift({ path });
      return appendDriftWarning(formatMcpText(text), driftWarning);
    },
  );

  // get_index_metrics
  registerToolSafe(
    server,
    "get_index_metrics",
    {
      title: "Get Index Metrics",
      description:
        "Get collection statistics and signal distributions. Returns percentile-based thresholds for git signals, " +
        "language/author/chunkType distributions. Use to discover appropriate filter values for your codebase. " +
        "For signal label definitions see tea-rags://schema/signal-labels.",
      inputSchema: schemas.GetIndexMetricsSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      const metrics = await app.getIndexMetrics(path);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(metrics, null, 2) }],
      };
    },
  );

  // clear_index
  registerToolSafe(
    server,
    "clear_index",
    {
      title: "Clear Index",
      description:
        "Delete all indexed data for a codebase. This is irreversible and will remove the entire collection.",
      inputSchema: schemas.ClearIndexSchema,
      annotations: { destructiveHint: true },
    },
    async ({ path }) => {
      await app.clearIndex(path);
      return formatMcpText(`Index cleared for codebase at "${path}".`);
    },
  );
}

function formatInfraHealth(h: NonNullable<IndexStatus["infraHealth"]>): string {
  const qdrantStatus = h.qdrant.available ? "available" : "unavailable";
  const embeddingStatus = h.embedding.available ? "available" : "unavailable";
  const embeddingUrl = h.embedding.url ? ` (${h.embedding.url})` : "";
  return (
    `Infrastructure:\n` +
    `  Qdrant: ${qdrantStatus} (${h.qdrant.url})\n` +
    `  Embedding (${h.embedding.provider}): ${embeddingStatus}${embeddingUrl}`
  );
}
