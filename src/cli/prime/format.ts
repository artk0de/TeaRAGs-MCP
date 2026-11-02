import { formatForPrime } from "../update-check/format.js";
import type { PrimeData, PrimeFailureReason } from "./types.js";

const REFRESH_LINE = '→ run `tea-rags prime "$CLAUDE_PROJECT_DIR"` to refresh this digest after re-indexing';

/**
 * The `tea-rags prime` output: the digest resource text, then the CLI-only
 * lines, the metrics resource text under `--full`, and the refresh line.
 * `--agent` prints the agent digest alone (bd tea-rags-mcp-nknkg.1).
 */
export function formatPrime(input: PrimeData | PrimeFailureReason, now: Date = new Date()): string {
  if ("kind" in input) {
    return formatFailure(input);
  }
  const blocks: string[] = [input.digest.trimEnd()];
  if (input.agent === true) {
    // The agent digest is the whole hook payload; only an auto-update pause names an action.
    if (input.autoUpdateOutcome === "branch-mismatch") {
      const autoUpdateLine = formatAutoUpdateLine(input, now);
      if (autoUpdateLine !== null) blocks.push(autoUpdateLine);
    }
    // A refused client-update step names an action too.
    if (input.clientUpdateHint) blocks.push(`tea-rags client: ${input.clientUpdateHint}`);
    if (input.metrics !== undefined) blocks.push(input.metrics.trimEnd());
    return `${blocks.join("\n")}\n`;
  }

  const autoUpdateLine = formatAutoUpdateLine(input, now);
  if (autoUpdateLine !== null) blocks.push(autoUpdateLine);
  if (input.clientUpdateHint) blocks.push(`tea-rags client: ${input.clientUpdateHint}`);

  const updateLines = input.update !== null ? formatForPrime(input.update) : [];
  if (updateLines.length > 0) blocks.push(updateLines.join("\n"));

  if (input.metrics !== undefined) blocks.push(input.metrics.trimEnd());

  blocks.push(REFRESH_LINE);
  return `${blocks.join("\n\n")}\n`;
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
    case "not-registered":
      return `# tea-rags prime — ${reason.path}\nnot indexed. Run \`/tea-rags:index\` to index this codebase.\n`;
    case "status-failed":
      return (
        `# tea-rags prime — ${reason.path}\n` +
        `Index status unavailable: ${reason.message}${reason.code ? ` (${reason.code})` : ""}\n${
          reason.hint ? `${reason.hint}\n` : ""
        }`
      );
  }
}

/**
 * Auto-update line (hpg2). Null = no line: trigger not fired, or config
 * disabled (the digest's stale banner carries the enable hint instead). A
 * failed lastRun dominates every fresh verdict — the operator must see the
 * failure and the log path before anything else.
 */
function formatAutoUpdateLine(data: PrimeData, now: Date): string | null {
  const outcome = data.autoUpdateOutcome;
  const config = data.registry?.autoUpdate;
  if (outcome === undefined || outcome === null || !config?.enabled) return null;

  const { lastRun } = config;
  if (lastRun?.outcome === "failed") {
    return `auto-update: failed ${formatAgo(lastRun.at, now)} ago — see ${data.autoUpdateLogPath ?? "the auto-update log"}`;
  }
  if (outcome === "eligible") {
    return `auto-update: on (${config.targetBranch}) · catching up in background`;
  }
  if (outcome === "branch-mismatch") {
    return `auto-update: paused — HEAD not on target ${config.targetBranch}; run \`index_codebase\` to switch the index`;
  }
  const lastRunSuffix = lastRun !== undefined ? ` · last run ${lastRun.outcome} ${formatAgo(lastRun.at, now)} ago` : "";
  return `auto-update: on (${config.targetBranch})${lastRunSuffix}`;
}

function formatAgo(at: string, now: Date): string {
  const diffMs = now.getTime() - new Date(at).getTime();
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) return `${Math.max(0, minutes)}m`;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(diffMs / (24 * 60 * 60 * 1000))}d`;
}
