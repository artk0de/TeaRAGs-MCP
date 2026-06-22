/**
 * Renders an {@link IndexStatus} as a compact multi-line block for stdout at the
 * end of an `index-codebase` run. Pure: input status + injected colorizer →
 * string. Mirrors the styling conventions of `cli/prime/format.ts`.
 */

import type { EnrichmentLevelHealth, EnrichmentMetrics, IndexStatus } from "../../core/api/public/index.js";
import type { Colorizer } from "../infra/color.js";
import type { EnrichmentOutcome } from "./ipc-protocol.js";

function levelLabel(level: EnrichmentLevelHealth): string {
  const base = level.status;
  return level.message ? `${base} (${level.message})` : base;
}

/** Format bytes as a human-readable string (B / KB / MB / GB). */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Map Qdrant collection status to the corresponding colorizer role. */
function qdrantStatusColor(qdrantStatus: string | undefined, colors: Colorizer): (s: string) => string {
  if (qdrantStatus === "green") return colors.ok;
  if (qdrantStatus === "yellow") return colors.warn;
  if (qdrantStatus === "red") return colors.alert;
  return colors.dim;
}

export interface FormatIndexStatusOpts {
  projectName?: string;
  path?: string;
}

export function formatIndexStatus(status: IndexStatus, colors: Colorizer, opts?: FormatIndexStatusOpts): string {
  const lines: string[] = [];
  lines.push(colors.bold("Index status"));

  // Project identification: project name takes precedence over path.
  if (opts?.projectName) {
    lines.push(`  project:    ${opts.projectName}`);
  } else if (opts?.path) {
    lines.push(`  path:       ${opts.path}`);
  }

  lines.push(`  status:     ${colors.brand(status.status)}`);
  if (status.collectionName) lines.push(`  collection: ${status.collectionName}`);
  if (status.chunksCount !== undefined) lines.push(`  chunks:     ${status.chunksCount}`);
  if (status.filesCount !== undefined) lines.push(`  files:      ${status.filesCount}`);

  // On-disk size (only when populated — embedded Qdrant path).
  if (status.indexSizeBytes !== undefined) {
    lines.push(`  size:       ${humanBytes(status.indexSizeBytes)}`);
  }

  if (status.languages?.length) lines.push(`  languages:  ${status.languages.join(", ")}`);
  if (status.embeddingModel) lines.push(`  embedding:  ${status.embeddingModel}`);

  // Qdrant infrastructure health.
  if (status.infraHealth?.qdrant) {
    const q = status.infraHealth.qdrant;
    const colorFn = qdrantStatusColor(q.status, colors);
    const label = q.status ?? (q.available ? "available" : "unavailable");
    lines.push(`  qdrant:     ${colorFn(label)}`);
  }

  if (status.enrichment && Object.keys(status.enrichment).length > 0) {
    lines.push(colors.bold("Enrichment"));
    for (const [provider, health] of Object.entries(status.enrichment)) {
      lines.push(`  ${provider}: file ${levelLabel(health.file)}, chunk ${levelLabel(health.chunk)}`);
    }
  }

  // Per-run enrichment metrics (injected from IndexStats at the CLI layer).
  if (status.enrichmentMetrics) {
    const m = status.enrichmentMetrics;
    lines.push(colors.bold("Enrichment metrics"));
    lines.push(`  matched     ${m.matchedFiles}`);
    lines.push(`  missed      ${m.missedFiles}`);
    lines.push(`  total       ${m.totalDurationMs}ms`);
  }

  return lines.join("\n");
}

export interface FormatIndexStatusJsonExtra {
  projectName?: string;
  path: string;
  phases?: Record<string, number>;
  overallMs?: number;
  outcome?: EnrichmentOutcome;
}

/**
 * Produce a stable, ANSI-free plain object for agent-facing `--json` output.
 * Shape is intentionally flat and versioned by field presence — callers MUST
 * NOT depend on field order.
 */
export function formatIndexStatusJson(status: IndexStatus, extra: FormatIndexStatusJsonExtra): object {
  const base: Record<string, unknown> = {
    projectName: extra.projectName ?? null,
    path: extra.path,
    status: status.status,
    collectionName: status.collectionName ?? null,
    filesCount: status.filesCount ?? null,
    chunksCount: status.chunksCount ?? null,
  };

  if (status.indexSizeBytes !== undefined) {
    base.indexSizeBytes = status.indexSizeBytes;
  }

  if (extra.overallMs !== undefined) {
    base.overallMs = extra.overallMs;
  }

  if (extra.phases) {
    base.phases = extra.phases;
  }

  if (extra.outcome) {
    base.outcome = { failed: extra.outcome.failed, degraded: extra.outcome.degraded };
  }

  if (status.infraHealth) {
    base.infraHealth = {
      qdrant: {
        available: status.infraHealth.qdrant.available,
        url: status.infraHealth.qdrant.url,
        status: status.infraHealth.qdrant.status ?? null,
      },
      embedding: {
        available: status.infraHealth.embedding.available,
        provider: status.infraHealth.embedding.provider,
      },
    };
  }

  if (status.enrichment) {
    base.enrichmentHealth = Object.fromEntries(
      Object.entries(status.enrichment).map(([k, v]) => [k, { file: v.file.status, chunk: v.chunk.status }]),
    );
  }

  if (status.enrichmentMetrics) {
    const m: EnrichmentMetrics = status.enrichmentMetrics;
    base.enrichmentMetrics = {
      matchedFiles: m.matchedFiles,
      missedFiles: m.missedFiles,
      totalDurationMs: m.totalDurationMs,
      prefetchDurationMs: m.prefetchDurationMs,
      chunkChurnDurationMs: m.chunkChurnDurationMs,
    };
  }

  return base;
}
