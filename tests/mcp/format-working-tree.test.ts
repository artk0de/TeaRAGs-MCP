import { describe, expect, it } from "vitest";

import { formatDenseUnavailable, formatWorkingTreeMarker } from "../../src/mcp/format.js";

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

/** The dense floor's line parts (bd tea-rags-mcp-xi2r9, WTO-5). */
describe("formatWorkingTreeMarker — dense floor", () => {
  it("should list the dense floor and say why some rows were ranked without a vector", () => {
    const text = formatWorkingTreeMarker({
      tree: "/repo/wt",
      indexedCommit: "0123456789abcdef0123456789abcdef01234567",
      treeCommit: "fedcba9876543210fedcba9876543210fedcba98",
      indexedDirty: false,
      changedFiles: 2,
      deletedFiles: 0,
      floors: ["chunks", "dense"],
      denseUnavailable: { reason: "connect ECONNREFUSED 127.0.0.1:1" },
    });

    expect(text).toBe(
      "workingTree: /repo/wt · index @0123456 · tree @fedcba9 · changed 2 · deleted 0 · floors chunks,dense" +
        " · dense unavailable: connect ECONNREFUSED 127.0.0.1:1",
    );
  });
});

/** On-demand git of changed-file rows past the answer deadline: the marker says how many rows lack it. */
describe("formatWorkingTreeMarker — git signals pending", () => {
  it("should say how many tree rows answered without their git signals", () => {
    const text = formatWorkingTreeMarker({
      tree: "/repo/wt",
      indexedCommit: "0123456789abcdef0123456789abcdef01234567",
      treeCommit: "fedcba9876543210fedcba9876543210fedcba98",
      indexedDirty: false,
      changedFiles: 2,
      deletedFiles: 0,
      floors: ["chunks", "sparse"],
      gitUnavailable: { reason: "3 rows pending" },
    });

    expect(text).toBe(
      "workingTree: /repo/wt · index @0123456 · tree @fedcba9 · changed 2 · deleted 0 · floors chunks,sparse" +
        " · git unavailable: 3 rows pending",
    );
  });
});

/** Delta admission: changed files served from the index are counted beside `changed`. */
describe("formatWorkingTreeMarker — index-only files", () => {
  it("should name how many changed files answer from the index", () => {
    const text = formatWorkingTreeMarker({
      tree: "/repo/wt",
      indexedCommit: "0123456789abcdef0123456789abcdef01234567",
      treeCommit: "fedcba9876543210fedcba9876543210fedcba98",
      indexedDirty: false,
      changedFiles: 5,
      deletedFiles: 0,
      floors: ["chunks"],
      indexOnlyFiles: 2,
    });

    expect(text).toBe(
      "workingTree: /repo/wt · index @0123456 · tree @fedcba9 · changed 5 (2 index-only) · deleted 0 · floors chunks",
    );
  });
});

/** Progressive warm: re-read files not yet warm answer from the index, counted beside `changed`. */
describe("formatWorkingTreeMarker — pending files", () => {
  const base = {
    tree: "/repo/wt",
    indexedCommit: "0123456789abcdef0123456789abcdef01234567",
    treeCommit: "fedcba9876543210fedcba9876543210fedcba98",
    indexedDirty: false,
    changedFiles: 5,
    deletedFiles: 0,
    floors: ["chunks" as const],
  };

  it("should name how many changed files are still warming", () => {
    expect(formatWorkingTreeMarker({ ...base, pendingFiles: 3 })).toBe(
      "workingTree: /repo/wt · index @0123456 · tree @fedcba9 · changed 5 (3 pending) · deleted 0 · floors chunks",
    );
  });

  it("should name index-only and pending files together", () => {
    expect(formatWorkingTreeMarker({ ...base, indexOnlyFiles: 2, pendingFiles: 3 })).toBe(
      "workingTree: /repo/wt · index @0123456 · tree @fedcba9 · changed 5 (2 index-only, 3 pending) · deleted 0 · floors chunks",
    );
  });
});

/** hybrid_search ranked by BM25 alone: the embedding provider could not embed the query. */
describe("formatDenseUnavailable", () => {
  it("should name the reason and the ranking the answer fell back to", () => {
    expect(formatDenseUnavailable({ reason: "No llama-server endpoint is reachable at http://127.0.0.1:9" })).toBe(
      "dense leg unavailable: No llama-server endpoint is reachable at http://127.0.0.1:9 — ranked by BM25 only",
    );
  });
});
