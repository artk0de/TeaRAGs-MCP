import { describe, expect, it } from "vitest";

import type { WorkingTreeMarker } from "../../../../src/core/contracts/types/working-tree.js";
import { toolCallAddressFromWorkingTree } from "../../../../src/core/domains/explore/tool-call-address.js";

function marker(overrides: Partial<WorkingTreeMarker> = {}): WorkingTreeMarker {
  return {
    tree: "/repo/.claude/worktrees/feature",
    indexedCommit: "aaa",
    treeCommit: "bbb",
    indexedDirty: false,
    changedFiles: 3,
    deletedFiles: 0,
    floors: ["chunks"],
    project: "acme",
    ...overrides,
  };
}

describe("toolCallAddressFromWorkingTree", () => {
  it("addresses the tree that answered, not the registered checkout", () => {
    expect(toolCallAddressFromWorkingTree(marker())).toEqual({
      project: "acme",
      path: "/repo/.claude/worktrees/feature",
    });
  });

  it("omits project when the answering index has no alias", () => {
    expect(toolCallAddressFromWorkingTree(marker({ project: undefined }))).toEqual({
      path: "/repo/.claude/worktrees/feature",
    });
  });

  it("returns an empty address when the answer carried no marker", () => {
    expect(toolCallAddressFromWorkingTree(undefined)).toEqual({});
  });
});
