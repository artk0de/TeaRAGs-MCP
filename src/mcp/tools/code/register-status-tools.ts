/**
 * Index inspection tools: get_index_status, get_index_metrics.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App, IndexStatus } from "../../../core/api/index.js";
import { appendDriftWarning, formatMcpText } from "../../format.js";
import type { RegisterToolFn } from "../../middleware/error-handler.js";
import * as schemas from "../schemas.js";
import { resolvePathFromProject } from "./shared.js";

export function registerStatusTools(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  const { app, register: registerToolSafe } = deps;

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
    async ({ path: pathArg, project }) => {
      const path = await resolvePathFromProject({ path: pathArg, project }, app);
      // Qdrant connectivity errors (unavailable / starting / recovering) are
      // thrown as typed errors by QdrantManager and handled by the MCP error
      // middleware — we don't mask them here by returning a text response.
      const status = await app.getIndexStatus(path);

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
          for (const [provider, health] of Object.entries(status.enrichment)) {
            text += `\n${provider} enrichment: file=${health.file.status}, chunk=${health.chunk.status}`;
          }
        }
        if (status.infraHealth) text += `\n\n${formatInfraHealth(status.infraHealth)}`;
        return formatMcpText(text);
      }

      const { enrichment, infraHealth, ...rest } = status;
      const response: Record<string, unknown> = { ...rest };
      if (enrichment) {
        response.enrichment = enrichment;
      }

      let text = JSON.stringify(response, null, 2);

      // Add visible enrichment status line for any in-progress providers
      if (enrichment) {
        for (const [provider, health] of Object.entries(enrichment)) {
          if (health.file.status === "in_progress" || health.chunk.status === "in_progress") {
            text += `\n\n[${provider} enrichment is still running. Git-based filters and rerank presets may not work until enrichment completes.]`;
          }
        }
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
        "Get collection statistics and signal distributions. Returns percentile-based thresholds for git signals " +
        "scoped by source/test: signals[lang][signal][scope].labelMap. " +
        "Use to discover appropriate filter values for your codebase. " +
        "For signal label definitions see tea-rags://schema/signal-labels.",
      inputSchema: schemas.GetIndexMetricsSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ path: pathArg, project }) => {
      const path = await resolvePathFromProject({ path: pathArg, project }, app);
      const metrics = await app.getIndexMetrics(path);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(metrics, null, 2) }],
      };
    },
  );
}

function formatInfraHealth(h: NonNullable<IndexStatus["infraHealth"]>): string {
  const qdrantStatus = h.qdrant.available ? "available" : "unavailable";
  const embeddingStatus = h.embedding.available ? "available" : "unavailable";
  const embeddingUrl = h.embedding.url ? ` (${h.embedding.url})` : "";
  const collectionHealth =
    h.qdrant.status && h.qdrant.status !== "green"
      ? ` [collection status: ${h.qdrant.status}${
          h.qdrant.optimizerStatus && h.qdrant.optimizerStatus !== "ok"
            ? `, optimizer: ${h.qdrant.optimizerStatus}`
            : ""
        }]`
      : "";
  return (
    `Infrastructure:\n` +
    `  Qdrant: ${qdrantStatus} (${h.qdrant.url})${collectionHealth}\n` +
    `  Embedding (${h.embedding.provider}): ${embeddingStatus}${embeddingUrl}`
  );
}
