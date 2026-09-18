/**
 * The one human wording of a seed outcome, shared by the CLI status block and
 * the MCP `index_codebase` response (bd tea-rags-mcp-k8gac).
 */
import { describe, expect, it } from "vitest";

import { formatWorktreeSeedReport } from "../../../../src/core/domains/maintenance/worktree/worktree-seed-report.js";

const main = { collectionName: "code_main", project: "tea-rags", path: "/repo/main" };

describe("formatWorktreeSeedReport", () => {
  it("names the sibling and the split between copied and embedded files", () => {
    const lines = formatWorktreeSeedReport({
      status: "seeded",
      source: main,
      filesCopied: 16463,
      filesIndexed: 11087,
      filesRemoved: 12,
      gitRefresh: "background",
      rejected: [],
    });
    expect(lines).toEqual([
      "seeded from tea-rags (/repo/main): 16463 files copied, 11087 embedded, 12 removed",
      "git signals: rebuilding against this worktree's history (background)",
    ]);
  });

  it("falls back to the collection name for an unnamed sibling, and says nothing of git when it is off", () => {
    const lines = formatWorktreeSeedReport({
      status: "seeded",
      source: { ...main, project: null },
      filesCopied: 3,
      filesIndexed: 1,
      filesRemoved: 0,
      gitRefresh: "not-applicable",
      rejected: [],
    });
    expect(lines).toEqual(["seeded from code_main (/repo/main): 3 files copied, 1 embedded, 0 removed"]);
  });

  it("lists every refused sibling with the stamp that refused it", () => {
    const lines = formatWorktreeSeedReport({
      status: "skipped",
      reason: "no-compatible-sibling",
      rejected: [
        { ...main, reason: "source-busy", detail: "an index run holds it" },
        {
          collectionName: "code_old",
          project: null,
          path: "/repo/old",
          reason: "language-versions",
          detail: "typescript.chunking 2 → 3",
        },
      ],
    });
    expect(lines).toEqual([
      "not seeded: no sibling worktree index matches this run",
      "  tea-rags (/repo/main): source-busy — an index run holds it",
      "  code_old (/repo/old): language-versions — typescript.chunking 2 → 3",
    ]);
  });

  it("says why a run did not even look for a sibling", () => {
    expect(formatWorktreeSeedReport({ status: "skipped", reason: "disabled", rejected: [] })).toEqual([
      "not seeded: disabled for this run",
    ]);
    expect(formatWorktreeSeedReport({ status: "skipped", reason: "restricted-run", rejected: [] })).toEqual([
      "not seeded: the run is restricted to custom extensions or ignore patterns",
    ]);
  });

  it("stays silent for a repository with no other indexed working tree — the ordinary first index", () => {
    expect(formatWorktreeSeedReport({ status: "skipped", reason: "no-sibling", rejected: [] })).toEqual([]);
  });
});
