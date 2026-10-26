import { describe, expect, it } from "vitest";

import type { WorkingTreeMarker } from "../../../../src/core/api/public/dto/working-tree.js";
import {
  compactWorkingTreeMarker,
  formatMcpResponse,
  formatWorkingTreeMarker,
} from "../../../../src/core/api/tools/format.js";

/**
 * bd tea-rags-mcp-45kbu: a clean answer's marker goes out as
 * `{ tree, project?, changedFiles: 0 }` on the MCP output. The full marker cost
 * ~268 chars on every answer and a clean tree gave the reader nothing to act on;
 * `changedFiles: 0` stays explicit — the agent rules read it as "measured clean".
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
  it("should keep only tree, project and changedFiles 0 on a clean marker", () => {
    expect(compactWorkingTreeMarker(clean)).toStrictEqual({ tree: "/repo/wt", project: "proj", changedFiles: 0 });
  });

  it("should omit project when the marker names no alias", () => {
    const { project: _project, ...unaliased } = clean;

    expect(compactWorkingTreeMarker(unaliased)).toStrictEqual({ tree: "/repo/wt", changedFiles: 0 });
  });

  const notClean: [string, Partial<WorkingTreeMarker>][] = [
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

  it.each(notClean)("should keep the full marker when %s is set", (_field, override) => {
    const marker = { ...clean, ...override };

    expect(compactWorkingTreeMarker(marker)).toBe(marker);
  });
});

describe("formatMcpResponse — workingTree marker", () => {
  const parse = (data: unknown): Record<string, unknown> =>
    JSON.parse(formatMcpResponse(data).content[0].text) as Record<string, unknown>;

  it("should emit a clean marker compact", () => {
    expect(parse({ edges: [], workingTree: clean }).workingTree).toStrictEqual({
      tree: "/repo/wt",
      project: "proj",
      changedFiles: 0,
    });
  });

  it("should emit a changed marker in full", () => {
    const changed = { ...clean, changedFiles: 3 };

    expect(parse({ edges: [], workingTree: changed }).workingTree).toStrictEqual(changed);
  });

  it("should not mutate the answer it serializes", () => {
    const answer = { edges: [], workingTree: clean };
    formatMcpResponse(answer);

    expect(answer.workingTree).toBe(clean);
  });
});

describe("formatWorkingTreeMarker — clean marker", () => {
  it("should render a clean marker as tree, project and changed 0 only", () => {
    expect(formatWorkingTreeMarker(clean)).toBe("workingTree: /repo/wt · project proj · changed 0");
  });
});
