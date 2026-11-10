/**
 * recordingTreeGraphReader identity (bd tea-rags-mcp-4qdj0, iteration 3) — one
 * reader CLOSURE per view. The closure's identity is what a request-scoped
 * tree-graph handle lease keys on, so every reader a request creates (the
 * symbol strategy's decorations, the file outline's, a batch's prefetch) must
 * share it. Memoized per view: same view → same closure, fresh state read on
 * every call (the closure re-reads `view.readTreeGraph` and the remaining
 * budget each time — memoizing the closure never memoizes the state).
 */
import { describe, expect, it, vi } from "vitest";

import type { WorkingTreeGraphState, WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";
import { recordingTreeGraphReader } from "../../../../../src/core/domains/explore/working-tree/tree-graph-marker.js";

const MARKER: WorkingTreeMarker = {
  tree: "/tree",
  indexedCommit: "a".repeat(40),
  treeCommit: "b".repeat(40),
  indexedDirty: false,
  changedFiles: 1,
  deletedFiles: 0,
  floors: [],
};

const BUILT: WorkingTreeGraphState = { kind: "built", dbPath: "/g.duckdb", physicalCollectionName: "c_v1" } as never;

const viewWithReader = (read?: ReturnType<typeof vi.fn>) => {
  const view: WorkingTreeView = {
    marker: { ...MARKER },
    touchedPaths: new Set(["src/a.ts"]),
    deletedPaths: new Set(),
  };
  if (read) view.readTreeGraph = read as never;
  return view;
};

describe("recordingTreeGraphReader identity (bd tea-rags-mcp-4qdj0)", () => {
  it("returns the same closure for one view — the identity a request-scoped lease keys on", () => {
    const view = viewWithReader(vi.fn(async () => BUILT));

    expect(recordingTreeGraphReader(view)).toBe(recordingTreeGraphReader(view));
  });

  it("returns a distinct closure for a distinct view", () => {
    const first = viewWithReader(vi.fn(async () => BUILT));
    const second = viewWithReader(vi.fn(async () => BUILT));

    expect(recordingTreeGraphReader(first)).not.toBe(recordingTreeGraphReader(second));
  });

  it("the memoized closure still reads fresh state on every call", async () => {
    const read = vi.fn(async () => BUILT);
    const view = viewWithReader(read);
    const reader = recordingTreeGraphReader(view);

    const first = await reader?.(50);
    const second = await reader?.(50);

    expect(read).toHaveBeenCalledTimes(2);
    expect(first).toEqual(BUILT);
    expect(second).toEqual(BUILT);
    expect(view.treeGraphLookup).toEqual(BUILT); // the recording semantics ride along
  });

  it("returns undefined for a view without readTreeGraph, stably", () => {
    const view = viewWithReader();

    expect(recordingTreeGraphReader(view)).toBeUndefined();
    expect(recordingTreeGraphReader(view)).toBeUndefined();
    expect(recordingTreeGraphReader(undefined)).toBeUndefined();
  });
});
