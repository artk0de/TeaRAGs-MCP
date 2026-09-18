/**
 * The one human wording of a first index's seed outcome (bd tea-rags-mcp-k8gac),
 * rendered by both the CLI status block and the MCP `index_codebase` response —
 * the same split `formatIndexDriftReport` makes for drift, so the two surfaces
 * cannot describe one outcome two ways.
 */

import type { WorktreeSeedReport, WorktreeSeedSourceRef } from "../../../contracts/types/worktree.js";

/** Lines to show, unindented except the per-sibling refusals; empty when there is nothing worth saying. */
export function formatWorktreeSeedReport(report: WorktreeSeedReport): string[] {
  if (report.status === "seeded") {
    const lines = [
      `seeded from ${labelOf(report.source)}: ${report.filesCopied} files copied, ` +
        `${report.filesIndexed} embedded, ${report.filesRemoved} removed`,
    ];
    if (report.gitRefresh === "background") {
      lines.push("git signals: rebuilding against this worktree's history (background)");
    }
    return [...lines, ...report.rejected.map(rejectionLine)];
  }
  switch (report.reason) {
    // The ordinary first index of a repository nobody else indexed: no news.
    case "no-sibling":
      return [];
    case "disabled":
      return ["not seeded: disabled for this run"];
    case "restricted-run":
      return ["not seeded: the run is restricted to custom extensions or ignore patterns"];
    case "no-compatible-sibling":
      return ["not seeded: no sibling worktree index matches this run", ...report.rejected.map(rejectionLine)];
  }
}

function labelOf(source: WorktreeSeedSourceRef): string {
  return `${source.project ?? source.collectionName} (${source.path})`;
}

function rejectionLine(rejection: WorktreeSeedReport["rejected"][number]): string {
  return `  ${labelOf(rejection)}: ${rejection.reason} — ${rejection.detail}`;
}
