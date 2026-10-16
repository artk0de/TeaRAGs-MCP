/**
 * A tree graph built without the changed files' model edges (bd
 * tea-rags-mcp-2m83f.39): the verdict store could not be read, so the answer
 * reads the tree graph — `codegraph` floor claimed — and `degraded` says which
 * edges it lacks.
 */
import { describe, expect, it } from "vitest";

import { fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { WorkingTreeGraphState } from "../../../../../src/core/contracts/types/working-tree.js";
import { recordTreeGraphState } from "../../../../../src/core/domains/explore/working-tree/index.js";

const BUILT = { kind: "built", dbPath: "/g.duckdb", physicalCollectionName: "code_x_v1" } as WorkingTreeGraphState;
const WITHOUT_MODEL_EDGES = {
  ...BUILT,
  modelEdgesUnavailable: "model edges of changed files not re-applied: verdict store unreadable: lock held",
} as WorkingTreeGraphState;

describe("recordTreeGraphState — model edges of changed files", () => {
  it("claims the tree graph and marks the answer degraded when the graph lacks them", () => {
    const view = fakeWorkingTreeView({ changed: ["src/a.ts"] });

    recordTreeGraphState(view.marker, WITHOUT_MODEL_EDGES);

    expect(view.marker.floors).toContain("codegraph");
    expect(view.marker.degraded).toEqual({
      reason: "model edges of changed files not re-applied: verdict store unreadable: lock held",
      remedy: expect.stringContaining("model (origin: model) edges") as string,
    });
  });

  it("leaves the marker undegraded when the graph has them", () => {
    const view = fakeWorkingTreeView({ changed: ["src/a.ts"] });

    recordTreeGraphState(view.marker, BUILT);

    expect(view.marker.floors).toContain("codegraph");
    expect(view.marker.degraded).toBeUndefined();
  });

  it("keeps an earlier degradation — the delta's own — instead of replacing it", () => {
    const view = fakeWorkingTreeView({ changed: ["src/a.ts"] });
    view.marker.degraded = { reason: "delta unmeasured", remedy: "retry" };

    recordTreeGraphState(view.marker, WITHOUT_MODEL_EDGES);

    expect(view.marker.degraded).toEqual({ reason: "delta unmeasured", remedy: "retry" });
  });
});
