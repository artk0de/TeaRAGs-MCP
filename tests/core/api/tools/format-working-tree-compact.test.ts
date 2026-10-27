import { describe, expect, it } from "vitest";

import type { WorkingTreeMarker } from "../../../../src/core/api/public/dto/working-tree.js";
import {
  compactWorkingTreeMarker,
  formatMcpResponse,
  formatWorkingTreeMarker,
} from "../../../../src/core/api/tools/format.js";

/**
 * bd tea-rags-mcp-45kbu, q1g6s.15: the marker on the MCP output carries only
 * what the reader acts on. An answer the overlay fully served — clean tree or
 * dirty — goes out as `{ tree, project? }`; one that is partly NOT current
 * names that part (degraded, treeGraphUnavailable, denseUnavailable,
 * pendingFiles, …) with the non-zero counts beside it. Never `floors`, the
 * commits or `indexedDirty`. A benchmark whose every answer carried the full
 * marker saw the agent stop trusting the index.
 */
const clean: WorkingTreeMarker = {
  tree: "/repo/wt",
  indexedCommit: "0123456789abcdef0123456789abcdef01234567",
  treeCommit: "0123456789abcdef0123456789abcdef01234567",
  indexedDirty: false,
  changedFiles: 0,
  deletedFiles: 0,
  floors: [],
  project: "proj",
};

describe("compactWorkingTreeMarker", () => {
  it("should keep only tree and project on a clean marker", () => {
    expect(compactWorkingTreeMarker(clean)).toStrictEqual({ tree: "/repo/wt", project: "proj" });
  });

  it("should omit project when the marker names no alias", () => {
    const { project: _project, ...unaliased } = clean;

    expect(compactWorkingTreeMarker(unaliased)).toStrictEqual({ tree: "/repo/wt" });
  });

  const qualifiers: [string, Partial<WorkingTreeMarker>][] = [
    ["degraded", { degraded: { reason: "no stamp", remedy: "reindex" } }],
    ["pendingFiles", { pendingFiles: 1 }],
    ["indexOnlyFiles", { indexOnlyFiles: 1 }],
    ["unparsed", { unparsed: ["a.ts"] }],
    ["treeGraphUnavailable", { treeGraphUnavailable: "building" }],
    ["denseUnavailable", { denseUnavailable: { reason: "embedder down" } }],
    ["gitUnavailable", { gitUnavailable: { reason: "computing" } }],
  ];

  it.each(qualifiers)("should keep %s beside tree and project, nothing else", (_field, override) => {
    const marker = { ...clean, ...override, floors: ["chunks" as const] };

    expect(compactWorkingTreeMarker(marker)).toStrictEqual({ tree: "/repo/wt", project: "proj", ...override });
  });

  // q1g6s.15 (live): an agent read `changedFiles: 378` on an answer the overlay
  // had served from its tree, decided the file "changed after indexing", and
  // re-read it from disk. A count alone never goes out.
  it("should send a dirty tree the overlay fully served as tree and project only", () => {
    const covered = { ...clean, treeCommit: "f".repeat(40), indexedDirty: true, changedFiles: 378, deletedFiles: 11 };

    expect(compactWorkingTreeMarker({ ...covered, floors: ["chunks", "codegraph"] })).toStrictEqual({
      tree: "/repo/wt",
      project: "proj",
    });
  });

  it("should send the counts as the size of the uncovered part beside treeGraphUnavailable", () => {
    const graphFell = { ...clean, changedFiles: 4, floors: ["chunks" as const], treeGraphUnavailable: "building" };

    expect(compactWorkingTreeMarker(graphFell)).toStrictEqual({
      tree: "/repo/wt",
      project: "proj",
      changedFiles: 4,
      treeGraphUnavailable: "building",
    });
  });

  it("should send a degraded marker with the reason that answers come from the index", () => {
    const reason =
      "working-tree overlay unavailable (git status failed): answers come from the index at its last indexed commit; " +
      "uncommitted edits are not reflected";
    const degraded = { ...clean, degraded: { reason, remedy: "check that /repo/wt is a readable git checkout" } };

    expect(compactWorkingTreeMarker(degraded)).toStrictEqual({
      tree: "/repo/wt",
      project: "proj",
      degraded: degraded.degraded,
    });
  });
});

describe("formatMcpResponse — workingTree marker", () => {
  const parse = (data: unknown): Record<string, unknown> =>
    JSON.parse(formatMcpResponse(data).content[0].text) as Record<string, unknown>;

  it("should emit a clean marker as tree and project", () => {
    expect(parse({ edges: [], workingTree: clean }).workingTree).toStrictEqual({ tree: "/repo/wt", project: "proj" });
  });

  it("should emit a lagging marker without floors, commits or indexedDirty", () => {
    const lagging = { ...clean, changedFiles: 3, floors: ["chunks" as const], pendingFiles: 2 };

    expect(parse({ edges: [], workingTree: lagging }).workingTree).toStrictEqual({
      tree: "/repo/wt",
      project: "proj",
      changedFiles: 3,
      pendingFiles: 2,
    });
  });

  it("should emit a changed marker the overlay fully served as tree and project", () => {
    const covered = { ...clean, changedFiles: 3, floors: ["codegraph" as const] };

    expect(parse({ edges: [], workingTree: covered }).workingTree).toStrictEqual({ tree: "/repo/wt", project: "proj" });
  });

  it("should not mutate the answer it serializes", () => {
    const answer = { edges: [], workingTree: clean };
    formatMcpResponse(answer);

    expect(answer.workingTree).toBe(clean);
  });
});

// icujw: a graph / review answer to a call that named both the index and the tree it got back drops the clean marker.
describe("formatMcpResponse — workingTree marker against the call's address", () => {
  const parse = (data: unknown, address: { project?: unknown; path?: unknown }): Record<string, unknown> =>
    JSON.parse(formatMcpResponse(data, [], address).content[0].text) as Record<string, unknown>;

  it("should drop a current marker when the call passed project and path = tree", () => {
    expect(parse({ edges: [], workingTree: clean }, { project: "proj", path: "/repo/wt" })).not.toHaveProperty(
      "workingTree",
    );
  });

  it("should keep a current marker for a path-only call (alias discovery)", () => {
    expect(parse({ edges: [], workingTree: clean }, { path: "/repo/wt" }).workingTree).toStrictEqual({
      tree: "/repo/wt",
      project: "proj",
    });
  });

  it("should keep a current marker when the tree is not the path the call named", () => {
    expect(parse({ edges: [], workingTree: clean }, { project: "proj", path: "/repo" }).workingTree).toStrictEqual({
      tree: "/repo/wt",
      project: "proj",
    });
  });

  it("should keep a lagging marker whatever the address", () => {
    const lagging = { ...clean, changedFiles: 3, pendingFiles: 2 };

    expect(parse({ edges: [], workingTree: lagging }, { project: "proj", path: "/repo/wt" }).workingTree).toStrictEqual(
      { tree: "/repo/wt", project: "proj", changedFiles: 3, pendingFiles: 2 },
    );
  });
});

describe("formatWorkingTreeMarker — clean marker", () => {
  it("should render a clean marker as tree and project only", () => {
    expect(formatWorkingTreeMarker(clean)).toBe("workingTree: /repo/wt · project proj");
  });
});
