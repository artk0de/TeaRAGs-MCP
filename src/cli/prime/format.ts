import type { IndexStatus } from "../../core/api/public/dto/ingest.js";
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
  lines.push("");
  return lines.join("\n");
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
