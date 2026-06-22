/**
 * Renders an {@link IndexStatus} as a compact multi-line block for stdout at the
 * end of an `index-codebase` run. Pure: input status + injected colorizer →
 * string. Mirrors the styling conventions of `cli/prime/format.ts`.
 */

import type { EnrichmentLevelHealth, IndexStatus } from "../../core/api/public/index.js";
import type { Colorizer } from "../infra/color.js";

function levelLabel(level: EnrichmentLevelHealth): string {
  const base = level.status;
  return level.message ? `${base} (${level.message})` : base;
}

export function formatIndexStatus(status: IndexStatus, colors: Colorizer): string {
  const lines: string[] = [];
  lines.push(colors.bold("Index status"));
  lines.push(`  status:     ${colors.brand(status.status)}`);
  if (status.collectionName) lines.push(`  collection: ${status.collectionName}`);
  if (status.chunksCount !== undefined) lines.push(`  chunks:     ${status.chunksCount}`);
  if (status.filesCount !== undefined) lines.push(`  files:      ${status.filesCount}`);
  if (status.languages?.length) lines.push(`  languages:  ${status.languages.join(", ")}`);
  if (status.embeddingModel) lines.push(`  embedding:  ${status.embeddingModel}`);

  if (status.enrichment && Object.keys(status.enrichment).length > 0) {
    lines.push(colors.bold("Enrichment"));
    for (const [provider, health] of Object.entries(status.enrichment)) {
      lines.push(`  ${provider}: file ${levelLabel(health.file)}, chunk ${levelLabel(health.chunk)}`);
    }
  }

  return lines.join("\n");
}
