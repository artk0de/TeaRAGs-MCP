// src/mcp/tools/formatters/enrichment.ts
import type { EnrichmentHealthMap } from "../../../core/domains/ingest/pipeline/enrichment/types.js";
import type { EnrichmentMetrics, IndexStatus } from "../../../core/types.js";

type GetIndexStatusFn = (path: string) => Promise<IndexStatus>;

export async function formatEnrichmentStatus(
  enrichmentStatus: string | undefined,
  enrichmentDurationMs: number | undefined,
  getIndexStatus: GetIndexStatusFn | undefined,
  path: string,
  metrics?: EnrichmentMetrics,
): Promise<string> {
  if (!enrichmentStatus || enrichmentStatus === "skipped") {
    return "";
  }

  if (enrichmentStatus === "background") {
    let message = await formatBackgroundEnrichment(getIndexStatus, path);
    if (metrics) {
      message += formatMetricsBreakdown(metrics);
    }
    return message;
  }

  let message = `\nGit enrichment: ${enrichmentStatus}`;
  if (enrichmentDurationMs) {
    message += ` (${(enrichmentDurationMs / 1000).toFixed(1)}s)`;
  }
  if (metrics) {
    message += formatMetricsBreakdown(metrics);
  }
  return message;
}

function formatMetricsBreakdown(metrics: EnrichmentMetrics): string {
  let result = `\n  trajectory.git.file: ${metrics.matchedFiles} files, prefetch ${(metrics.prefetchDurationMs / 1000).toFixed(1)}s`;
  if (metrics.chunkChurnDurationMs > 0) {
    result += `\n  trajectory.git.chunk: ${(metrics.chunkChurnDurationMs / 1000).toFixed(1)}s`;
  }
  return result;
}

async function formatBackgroundEnrichment(getIndexStatus: GetIndexStatusFn | undefined, path: string): Promise<string> {
  if (!getIndexStatus) {
    return "\n\n[Git enrichment is running in background. Use get_index_status to track progress.]";
  }

  try {
    const currentStatus = await getIndexStatus(path);
    if (!currentStatus.enrichment) {
      return "\n\n[Git enrichment is running in background. Use get_index_status to track progress.]";
    }

        return formatEnrichmentHealthMap(currentStatus.enrichment);
  } catch {
    return "\n\n[Git enrichment is running in background. Use get_index_status to track progress.]";
  }
}

function formatEnrichmentHealthMap(map: EnrichmentHealthMap): string {
  const providers = Object.keys(map);
  if (providers.length === 0) return "";

  let message = "\n\nEnrichment health:";
  for (const provider of providers) {
    const h = map[provider];
    message += `\n  ${provider}.file: ${h.file.status}`;
    if (h.file.message) message += ` — ${h.file.message}`;
    message += `\n  ${provider}.chunk: ${h.chunk.status}`;
    if (h.chunk.message) message += ` — ${h.chunk.message}`;
  }
  return message;
}
