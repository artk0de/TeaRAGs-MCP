import type { PrimeData, PrimeFailureReason } from "./types.js";

export function formatPrime(input: PrimeData | PrimeFailureReason): string {
  if ("kind" in input) {
    return formatFailure(input);
  }
  // TODO Task 3+: handle full digest
  return "# tea-rags prime\n";
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
