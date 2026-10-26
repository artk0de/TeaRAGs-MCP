/**
 * `next` expansion hints on a search answer (agent turn economy N5, bd
 * tea-rags-mcp-r4rl1). In localization the agent stops at the first anchor
 * while half the gold files are its co-change / importer neighbours; the hint
 * sits at the decision point — the answer — as ready-to-run calls addressed to
 * the tree that answered.
 */

import { describe, expect, it } from "vitest";

import { buildSearchExpansionCalls } from "../../../../../src/core/api/internal/ops/search-expansion-calls.js";
import type { WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";

const MARKER: WorkingTreeMarker = {
  tree: "/repo/.claude/worktrees/feature",
  indexedCommit: "a".repeat(40),
  treeCommit: "b".repeat(40),
  indexedDirty: false,
  changedFiles: 1,
  deletedFiles: 0,
  floors: [],
  project: "tea-rags",
};

const hit = (relativePath: string, language = "typescript", extra: Record<string, unknown> = {}) => ({
  payload: { relativePath, language, ...extra },
});

describe("buildSearchExpansionCalls", () => {
  it("emits find_co_changed on the top two files and get_callers on the top one, addressed to the tree", () => {
    const calls = buildSearchExpansionCalls([hit("src/a.ts"), hit("src/b.ts"), hit("src/c.ts")], MARKER);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      tool: "find_co_changed",
      args: { project: "tea-rags", path: "/repo/.claude/worktrees/feature", files: ["src/a.ts", "src/b.ts"] },
    });
    expect(calls[1]).toMatchObject({
      tool: "get_callers",
      args: { project: "tea-rags", path: "/repo/.claude/worktrees/feature", relativePath: "src/a.ts" },
    });
    for (const call of calls) expect(call.why.length).toBeGreaterThan(0);
  });

  it("collapses the chunks of one file into one anchor", () => {
    const calls = buildSearchExpansionCalls([hit("src/a.ts"), hit("src/a.ts"), hit("src/b.ts")], MARKER);

    expect(calls[0]?.args.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("names one file when the answer holds only one", () => {
    const calls = buildSearchExpansionCalls([hit("src/a.ts"), hit("src/a.ts")], MARKER);

    expect(calls[0]?.args.files).toEqual(["src/a.ts"]);
    expect(calls[1]?.args.relativePath).toBe("src/a.ts");
  });

  it("skips doc chunks when choosing anchors", () => {
    const calls = buildSearchExpansionCalls(
      [hit("README.md", "markdown"), hit("docs/x.md", "typescript", { isDocumentation: true }), hit("src/a.ts")],
      MARKER,
    );

    expect(calls[0]?.args.files).toEqual(["src/a.ts"]);
  });

  it("emits nothing for a docs-only answer", () => {
    expect(buildSearchExpansionCalls([hit("README.md", "markdown")], MARKER)).toEqual([]);
  });

  it("emits nothing for an empty answer", () => {
    expect(buildSearchExpansionCalls([], MARKER)).toEqual([]);
  });

  it("carries no address when the answer has no working-tree marker", () => {
    const calls = buildSearchExpansionCalls([hit("src/a.ts")], undefined);

    expect(calls[0]?.args).toEqual({ files: ["src/a.ts"] });
  });
});
