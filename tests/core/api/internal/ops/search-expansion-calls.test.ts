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
  it("emits get_callees then get_callers on the top file, find_co_changed on the top two last, addressed to the tree", () => {
    const calls = buildSearchExpansionCalls([hit("src/a.ts"), hit("src/b.ts"), hit("src/c.ts")], MARKER);
    const address = { project: "tea-rags", path: "/repo/.claude/worktrees/feature" };

    expect(calls.map((call) => call.tool)).toEqual(["get_callees", "get_callers", "find_co_changed"]);
    expect(calls[0]?.args).toEqual({ ...address, relativePath: "src/a.ts" });
    expect(calls[1]?.args).toEqual({ ...address, relativePath: "src/a.ts" });
    expect(calls[2]?.args).toEqual({ ...address, files: ["src/a.ts", "src/b.ts"] });
  });

  it("names the concrete anchor files and the reason in every why", () => {
    const calls = buildSearchExpansionCalls([hit("src/a.ts"), hit("src/b.ts")], MARKER);

    expect(calls.map((call) => call.why)).toEqual([
      "files src/a.ts imports — change candidates",
      "files importing src/a.ts — callers to update",
      "files co-edited with src/a.ts, src/b.ts in git history",
    ]);
  });

  it("skips test files when choosing anchors — the payload's test classification, not a path rule", () => {
    const calls = buildSearchExpansionCalls(
      [
        hit("spec/models/user_spec.rb", "ruby", { isTest: true }),
        hit("tests/__helpers__/x.ts", "typescript", { codegraph: { symbols: { file: { skippedAs: "test" } } } }),
        hit("src/a.ts"),
      ],
      MARKER,
    );

    expect(calls[0]?.args.relativePath).toBe("src/a.ts");
    expect(calls[2]?.args.files).toEqual(["src/a.ts"]);
  });

  it("emits nothing for a tests-only answer", () => {
    expect(buildSearchExpansionCalls([hit("tests/a.test.ts", "typescript", { isTest: true })], MARKER)).toEqual([]);
  });

  it("collapses the chunks of one file into one anchor", () => {
    const calls = buildSearchExpansionCalls([hit("src/a.ts"), hit("src/a.ts"), hit("src/b.ts")], MARKER);

    expect(calls[2]?.args.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("names one file when the answer holds only one", () => {
    const calls = buildSearchExpansionCalls([hit("src/a.ts"), hit("src/a.ts")], MARKER);

    expect(calls[2]?.args.files).toEqual(["src/a.ts"]);
    expect(calls[0]?.args.relativePath).toBe("src/a.ts");
  });

  it("skips doc chunks when choosing anchors", () => {
    const calls = buildSearchExpansionCalls(
      [hit("README.md", "markdown"), hit("docs/x.md", "typescript", { isDocumentation: true }), hit("src/a.ts")],
      MARKER,
    );

    expect(calls[2]?.args.files).toEqual(["src/a.ts"]);
  });

  it("emits nothing for a docs-only answer", () => {
    expect(buildSearchExpansionCalls([hit("README.md", "markdown")], MARKER)).toEqual([]);
  });

  it("emits nothing for an empty answer", () => {
    expect(buildSearchExpansionCalls([], MARKER)).toEqual([]);
  });

  it("addresses get_callees / get_callers by the row's code symbolId — relativePath answers import edges only (q1g6s.15)", () => {
    const calls = buildSearchExpansionCalls(
      [hit("src/a.ts", "typescript", { symbolId: "A#run" }), hit("src/b.ts")],
      MARKER,
    );
    const address = { project: "tea-rags", path: "/repo/.claude/worktrees/feature" };

    expect(calls.map((call) => call.tool)).toEqual(["get_callees", "get_callers", "find_co_changed"]);
    expect(calls[0]?.args).toEqual({ ...address, symbolId: "A#run" });
    expect(calls[1]?.args).toEqual({ ...address, symbolId: "A#run" });
    expect(calls[2]?.args).toEqual({ ...address, files: ["src/a.ts", "src/b.ts"] });
  });

  it("addresses a #partN window by the symbol it splits", () => {
    const calls = buildSearchExpansionCalls(
      [hit("src/a.ts", "typescript", { symbolId: "A#run#part2", parentSymbolId: "A#run" })],
      MARKER,
    );

    expect(calls[0]?.args.symbolId).toBe("A#run");
  });

  it("keeps relativePath for a row with no code symbolId", () => {
    const calls = buildSearchExpansionCalls([hit("src/a.ts", "typescript", { symbolId: "doc:abc123" })], MARKER);

    expect(calls[0]?.args).not.toHaveProperty("symbolId");
    expect(calls[0]?.args.relativePath).toBe("src/a.ts");
  });

  it("symbol scope: graph hints on the named symbol only, no file-level co-change", () => {
    const calls = buildSearchExpansionCalls(
      [hit("src/a.ts", "typescript", { symbolId: "A#run" }), hit("src/b.ts", "typescript", { symbolId: "B#go" })],
      MARKER,
      "symbol",
    );

    expect(calls.map((call) => [call.tool, call.args.symbolId])).toEqual([
      ["get_callees", "A#run"],
      ["get_callers", "A#run"],
    ]);
  });

  it("file scope: the file the answer outlines, by relativePath, whatever its rows' ids", () => {
    const calls = buildSearchExpansionCalls([hit("src/a.ts", "typescript", { symbolId: "A#run" })], MARKER, "file");

    expect(calls[0]?.args.relativePath).toBe("src/a.ts");
    expect(calls[2]?.args.files).toEqual(["src/a.ts"]);
  });

  it("carries no address when the answer has no working-tree marker", () => {
    const calls = buildSearchExpansionCalls([hit("src/a.ts")], undefined);

    expect(calls[0]?.args).toEqual({ relativePath: "src/a.ts" });
    expect(calls[2]?.args).toEqual({ files: ["src/a.ts"] });
  });
});
