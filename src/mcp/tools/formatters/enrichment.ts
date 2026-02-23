// src/mcp/tools/formatters/enrichment.ts
import type { EnrichmentInfo, IndexStatus } from "../../../core/code/types.js";

type GetIndexStatusFn = (path: string) => Promise<IndexStatus>;

export async function formatEnrichmentStatus(
  enrichmentStatus: string | undefined,
  enrichmentDurationMs: number | undefined,
  getIndexStatus: GetIndexStatusFn | undefined,
  path: string,
): Promise<string> {
  if (!enrichmentStatus || enrichmentStatus === "skipped") {
    return "";
  }

  if (enrichmentStatus === "background") {
    return formatBackgroundEnrichment(getIndexStatus, path);
  }

  let message = `\nGit enrichment: ${enrichmentStatus}`;
  if (enrichmentDurationMs) {
    message += ` (${(enrichmentDurationMs / 1000).toFixed(1)}s)`;
  }
  return message;
}

async function formatBackgroundEnrichment(
  getIndexStatus: GetIndexStatusFn | undefined,
  path: string,
): Promise<string> {
  if (!getIndexStatus) {
    return "\n\n[Git enrichment is running in background. Use get_index_status to track progress.]";
  }

  try {
    const currentStatus = await getIndexStatus(path);
    if (!currentStatus.enrichment) {
      return "\n\n[Git enrichment is running in background. Use get_index_status to track progress.]";
    }

    return formatEnrichmentInfo(currentStatus.enrichment);
  } catch {
    return "\n\n[Git enrichment is running in background. Use get_index_status to track progress.]";
  }
}

function formatEnrichmentInfo(e: EnrichmentInfo): string {
  let message = `\n\nGit enrichment: ${e.status}`;

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

  return message;
}
