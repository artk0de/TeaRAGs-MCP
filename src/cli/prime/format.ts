import type { IndexStatus } from "../../core/api/public/dto/ingest.js";
import type { IndexMetrics } from "../../core/api/public/dto/metrics.js";
import type { PrimeData, PrimeFailureReason } from "./types.js";

export function formatPrime(input: PrimeData | PrimeFailureReason): string {
  if ("kind" in input) {
    return formatFailure(input);
  }
  return formatDigest(input);
}

function formatFailure(reason: PrimeFailureReason): string {
  switch (reason.kind) {
    case "path-not-found":
      return `# tea-rags prime\nPath not found: ${reason.path}\n`;
    case "qdrant-cold":
      return (
        `# tea-rags prime — ${reason.path}\n` +
        `Qdrant warm-up pending — index queries will be available after MCP server attaches.\n`
      );
  }
}

function formatDigest(data: PrimeData): string {
  const lines: string[] = [];
  lines.push(`# tea-rags prime — ${data.path}`);
  lines.push("");
  lines.push("## Status");
  lines.push(formatStatusLine(data.status));

  if (data.status.status !== "indexed") {
    return `${lines.join("\n")}\n`;
  }

  // Primary language is derived from IndexMetrics.distributions.language
  // (Record<string, number>, sorted by chunk count desc). IndexStatus.languages
  // is declared but never populated by any producer — do not use it.
  const languages = sortedLanguages(data.metrics);
  if (languages.length > 0) {
    lines.push("");
    lines.push(...formatLanguageSection(languages));
  }

  if (data.metrics && languages.length > 0) {
    const primary = languages[0];
    if (primary && data.metrics.signals[primary]) {
      lines.push("");
      lines.push(...formatThresholdsSection(primary, data.metrics.signals[primary]));
    }
  }

  return `${lines.join("\n")}\n`;
}

function sortedLanguages(metrics: IndexMetrics | null): string[] {
  if (!metrics?.distributions?.language) return [];
  return Object.entries(metrics.distributions.language)
    .sort(([, a], [, b]) => b - a)
    .map(([lang]) => lang);
}

function formatLanguageSection(languages: string[]): string[] {
  if (languages.length === 1) {
    return ["## Language", languages[0]];
  }
  const [primary, ...rest] = languages;
  return [
    "## Polyglot",
    `primary: ${primary} · also: ${rest.join(", ")}`,
    "→ for non-primary languages, call `get_index_metrics` for their labelMap",
  ];
}

function formatThresholdsSection(
  language: string,
  signals: Record<string, Record<string, { labelMap: Record<string, number> }>>,
): string[] {
  const lines = [`## Signal thresholds — ${language}`, ""];
  for (const [signalName, scopes] of Object.entries(signals)) {
    const source = scopes.source ? formatLabelMap(scopes.source.labelMap) : "—";
    const test = scopes.test ? formatLabelMap(scopes.test.labelMap) : "—";
    lines.push(`- **${signalName}**`);
    lines.push(`  - source: ${source}`);
    lines.push(`  - test:   ${test}`);
  }
  return lines;
}

function formatLabelMap(labelMap: Record<string, number>): string {
  return Object.entries(labelMap)
    .map(([label, threshold]) => `${label} ≤${threshold}`)
    .join(" / ")
    .replace(/extreme ≤(\d+)/, "extreme >$1");
}

function formatStatusLine(status: IndexStatus): string {
  switch (status.status) {
    case "not_indexed":
      return "not indexed. Run `/tea-rags:index` to index this codebase.";
    case "stale_indexing":
      return (
        "stale indexing marker (previous run crashed). " +
        "Re-run /tea-rags:index — stale collection will be cleaned up."
      );
    case "indexing":
      return `indexing in progress (${status.chunksCount ?? 0} chunks so far). Re-prime after completion.`;
    case "indexed":
      return `indexed · collection \`${status.collectionName ?? "unknown"}\` · ${status.chunksCount ?? 0} chunks`;
    case "unavailable":
      return "index unavailable.";
  }
}
