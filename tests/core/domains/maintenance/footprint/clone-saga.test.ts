import { describe, expect, it, vi } from "vitest";

import {
  cloneCollectionFootprint,
  removeCollectionFootprint,
} from "../../../../../src/core/domains/maintenance/footprint/clone-saga.js";

/**
 * The saga walks (bd tea-rags-mcp-54xwd.2): the per-artifact clone order, the
 * reverse rollback and the forgiving teardown moved here from the worktree
 * provisioner tests when the provisioner switched to the intent-level
 * `CollectionFootprintPort` — the walk is the footprint domain's own behavior,
 * driven through the same free functions the factory's port methods delegate to.
 */

function fakeArtifact(id: string, calls: string[], failOn?: string) {
  return {
    id,
    clone: vi.fn(async () => {
      calls.push(`clone:${id}`);
      if (failOn === id) throw new Error(`boom ${id}`);
    }),
    remove: vi.fn(async () => {
      calls.push(`remove:${id}`);
      if (failOn === `remove:${id}`) throw new Error(`boom remove ${id}`);
    }),
  };
}

/** Stub factory — the saga takes `Pick<CollectionFootprintFactory, "build">`; only `build` is read. */
function stubFactory(artifacts: unknown[]) {
  return {
    build: vi.fn(() => ({
      context: { source: {}, target: { logicalName: "code_dst" } },
      artifacts,
    })),
  };
}

describe("cloneCollectionFootprint", () => {
  it("clones every artifact in build order", async () => {
    const calls: string[] = [];
    const factory = stubFactory(
      ["qdrant", "codegraph", "snapshot", "stats", "quarantine"].map((id) => fakeArtifact(id, calls)),
    );
    await cloneCollectionFootprint(factory as never, {} as never, {} as never);
    expect(calls).toEqual(["clone:qdrant", "clone:codegraph", "clone:snapshot", "clone:stats", "clone:quarantine"]);
  });

  it("rolls back ALL artifacts including the failing one in reverse on failure", async () => {
    // The failing artifact (snapshot) must participate in rollback
    const calls: string[] = [];
    const factory = stubFactory(
      ["qdrant", "codegraph", "snapshot"].map((id) =>
        fakeArtifact(id, calls, id === "snapshot" ? "snapshot" : undefined),
      ),
    );
    await expect(cloneCollectionFootprint(factory as never, {} as never, {} as never)).rejects.toThrow(/boom snapshot/);
    expect(calls).toEqual([
      "clone:qdrant",
      "clone:codegraph",
      "clone:snapshot",
      "remove:snapshot", // failing artifact participates in rollback
      "remove:codegraph",
      "remove:qdrant",
    ]);
  });

  it("rollback survives an artifact whose remove also fails, and still surfaces the clone error", async () => {
    const calls: string[] = [];
    const factory = stubFactory([
      {
        id: "qdrant",
        clone: vi.fn(async () => {
          calls.push("clone:qdrant");
        }),
        // Rollback of this one fails — must be swallowed, not masked over the real cause.
        remove: vi.fn(async () => {
          calls.push("remove:qdrant");
          throw new Error("qdrant delete refused");
        }),
      },
      {
        id: "codegraph",
        clone: vi.fn(async () => {
          calls.push("clone:codegraph");
          throw new Error("boom codegraph");
        }),
        remove: vi.fn(async () => {
          calls.push("remove:codegraph");
        }),
      },
    ]);

    await expect(cloneCollectionFootprint(factory as never, {} as never, {} as never)).rejects.toThrow(
      "boom codegraph",
    );
    // Reverse order, and the failing rollback did not stop the earlier artifact from being undone.
    expect(calls).toEqual(["clone:qdrant", "clone:codegraph", "remove:codegraph", "remove:qdrant"]);
  });
});

describe("removeCollectionFootprint", () => {
  it("walks the artifacts in reverse clone order and swallows a failing teardown", async () => {
    // Rollback and teardown are deliberately forgiving: a half-written artifact
    // must not be able to strand the operation. A failing teardown is a
    // non-fatal skip, and the artifacts cloned after it are still undone.
    const removed: string[] = [];
    const factory = stubFactory([
      {
        id: "qdrant",
        clone: vi.fn(),
        remove: vi.fn(async () => {
          removed.push("qdrant");
        }),
      },
      {
        id: "stats",
        clone: vi.fn(),
        remove: vi.fn(async () => {
          removed.push("stats");
          throw new Error("stats file locked");
        }),
      },
    ]);

    await removeCollectionFootprint(factory as never, {} as never, {} as never);
    expect(removed).toEqual(["stats", "qdrant"]);
  });
});
