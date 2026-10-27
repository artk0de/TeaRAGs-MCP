import { describe, expect, it } from "vitest";

import type { WorkingTreeMarker } from "../../../../src/core/api/public/dto/working-tree.js";
import {
  compactWorkingTreeMarker,
  formatMcpResponse,
  formatWorkingTreeMarker,
} from "../../../../src/core/api/tools/format.js";

/**
 * bd tea-rags-mcp-45kbu, q1g6s.15: the marker on the MCP output carries only
 * what the reader acts on. A clean answer goes out as `{ tree, project? }`
 * (absent counts = measured clean); a lagging or degraded one keeps its
 * non-zero counts and qualifiers, never `floors`, the commits or
 * `indexedDirty`. A benchmark whose every answer carried the full marker saw
 * the agent stop trusting the index.
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
    ["changedFiles", { changedFiles: 2 }],
    ["deletedFiles", { deletedFiles: 1 }],
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

  it("should drop a zero count beside a non-zero one", () => {
    expect(compactWorkingTreeMarker({ ...clean, changedFiles: 4 })).toStrictEqual({
      tree: "/repo/wt",
      project: "proj",
      changedFiles: 4,
    });
  });
});

describe("formatMcpResponse — workingTree marker", () => {
  const parse = (data: unknown): Record<string, unknown> =>
    JSON.parse(formatMcpResponse(data).content[0].text) as Record<string, unknown>;

  it("should emit a clean marker as tree and project", () => {
    expect(parse({ edges: [], workingTree: clean }).workingTree).toStrictEqual({ tree: "/repo/wt", project: "proj" });
  });

  it("should emit a changed marker without floors, commits or indexedDirty", () => {
    const changed = { ...clean, changedFiles: 3, floors: ["codegraph" as const] };

    expect(parse({ edges: [], workingTree: changed }).workingTree).toStrictEqual({
      tree: "/repo/wt",
      project: "proj",
      changedFiles: 3,
    });
  });

  it("should not mutate the answer it serializes", () => {
    const answer = { edges: [], workingTree: clean };
    formatMcpResponse(answer);

    expect(answer.workingTree).toBe(clean);
  });
});

describe("formatWorkingTreeMarker — clean marker", () => {
  it("should render a clean marker as tree and project only", () => {
    expect(formatWorkingTreeMarker(clean)).toBe("workingTree: /repo/wt · project proj");
  });
});
