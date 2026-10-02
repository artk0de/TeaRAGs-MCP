import { describe, expect, it } from "vitest";

import { formatWorkingTreeMarker } from "../../src/mcp/format.js";

/** The one-line text render of the `workingTree` marker (bd tea-rags-mcp-xi2r9.1). */
describe("formatWorkingTreeMarker", () => {
  const base = {
    tree: "/repo/wt",
    indexedCommit: "0123456789abcdef0123456789abcdef01234567",
    treeCommit: "fedcba9876543210fedcba9876543210fedcba98",
    indexedDirty: false,
    changedFiles: 3,
    deletedFiles: 1,
    floors: [] as ("chunks" | "sparse")[],
  };

  it("should render a measured marker on one line", () => {
    expect(formatWorkingTreeMarker(base)).toBe(
      "workingTree: /repo/wt · index @0123456 · tree @fedcba9 · changed 3 · deleted 1 · floors none",
    );
  });

  it("should list floors and append the degradation with its remedy", () => {
    const text = formatWorkingTreeMarker({
      ...base,
      indexedCommit: null,
      floors: ["chunks", "sparse"],
      degraded: { reason: "index has no indexedCommit stamp", remedy: "tea-rags index-codebase --project p" },
    });

    expect(text).toBe(
      "workingTree: /repo/wt · index @none · tree @fedcba9 · changed 3 · deleted 1 · floors chunks,sparse" +
        " · degraded: index has no indexedCommit stamp → tea-rags index-codebase --project p",
    );
  });
});
