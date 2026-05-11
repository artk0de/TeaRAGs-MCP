import type { IndexStatus } from "../../core/api/public/dto/ingest.js";
import type { IndexMetrics } from "../../core/api/public/dto/metrics.js";
import type { PrimeData, PrimeFailureReason } from "./types.js";

type InfraHealth = NonNullable<IndexStatus["infraHealth"]>;
type EnrichmentMap = NonNullable<IndexStatus["enrichment"]>;

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function formatPrime(input: PrimeData | PrimeFailureReason, now: Date = new Date()): string {
  if ("kind" in input) {
    return formatFailure(input);
  }
  return formatDigest(input, now);
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

function formatDigest(data: PrimeData, now: Date): string {
  const lines: string[] = [];
  lines.push(`# tea-rags prime — ${data.path}`);
  lines.push("");
  lines.push("## Status");
  lines.push(formatStatusLine(data.status, now));

  if (data.status.status !== "indexed") {
    return `${lines.join("\n")}\n`;
  }

  const staleness = computeStaleness(data.status.lastUpdated, now);
  if (staleness?.stale) {
    lines.push("");
    lines.push(
      `⚠ Index is stale (last updated ${staleness.ago} ago). ` +
        "Run `index_codebase` before the next tea-rags search/explore.",
    );
  }

  lines.push("");
  lines.push("## Schema drift");
  lines.push(data.drift ?? "none");

  if (data.status.infraHealth) {
    lines.push("");
    lines.push(...formatInfraSection(data.status.infraHealth));
  }

  if (data.status.enrichment) {
    lines.push("");
    lines.push(...formatEnrichmentSection(data.status.enrichment));
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

function formatStatusLine(status: IndexStatus, now: Date): string {
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
    case "indexed": {
      const base = `indexed · collection \`${status.collectionName ?? "unknown"}\` · ${status.chunksCount ?? 0} chunks`;
      const staleness = computeStaleness(status.lastUpdated, now);
      return staleness ? `${base} · last indexed: ${staleness.ago} ago` : base;
    }
    case "unavailable":
      return "index unavailable.";
  }
}

function computeStaleness(lastUpdated: Date | undefined, now: Date): { ago: string; stale: boolean } | null {
  if (!lastUpdated) return null;
  const diffMs = now.getTime() - new Date(lastUpdated).getTime();
  return { ago: formatRelativeTime(diffMs), stale: diffMs > STALE_THRESHOLD_MS };
}

function formatInfraSection(infra: InfraHealth): string[] {
  const lines = ["## Infra"];
  const q = infra.qdrant;
  let qLine = `qdrant: ${q.status ?? "unknown"} (optimizer ${q.optimizerStatus ?? "unknown"}) at ${q.url}`;
  if (q.status === "yellow") {
    qLine += " — background optimization in progress";
  } else if (q.status === "red") {
    qLine += " — UNAVAILABLE, search will fail";
  }
  lines.push(qLine);

  const e = infra.embedding;
  const availability = e.available ? "available" : "unavailable";
  const eAt = e.url ? ` at ${e.url}` : "";
  lines.push(`embedding: ${availability} · ${e.provider}${eAt}`);
  return lines;
}

function formatEnrichmentSection(enrichment: EnrichmentMap): string[] {
  const lines = ["## Enrichment"];
  for (const [provider, health] of Object.entries(enrichment)) {
    const inProgress = health.file.status === "in_progress" || health.chunk.status === "in_progress";
    const suffix = inProgress ? " (in progress)" : "";
    lines.push(`${provider}: file ${health.file.status}, chunk ${health.chunk.status}${suffix}`);
  }
  return lines;
}

function formatRelativeTime(diffMs: number): string {
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) return `${Math.max(0, minutes)}m`;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return `${days}d`;
}
