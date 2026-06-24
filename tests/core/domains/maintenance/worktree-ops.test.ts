import { describe, expect, it, vi } from "vitest";
import { WorktreeOps } from "../../../../src/core/domains/maintenance/worktree/worktree-ops.js";

function fakeArtifact(id: string, calls: string[], failOn?: string) {
  return {
    id,
    clone: vi.fn(async () => {
      calls.push(`clone:${id}`);
      if (failOn === id) throw new Error(`boom ${id}`);
    }),
    remove: vi.fn(async () => {
      calls.push(`remove:${id}`);
    }),
  };
}

function makeDeps(over: Partial<Record<string, unknown>> = {}, calls: string[] = [], failOn?: string) {
  const sourceEntry = {
    collectionName: "code_src",
    path: "/repo",
    name: "proj",
    embeddingModel: "j",
    embeddingDimensions: 768,
    qdrantUrl: "http://h",
    codegraphEnabled: true,
    indexedAt: "t",
    teaRagsVersion: "1",
    chunksCount: 5,
  };
  const recorded: Record<string, unknown>[] = [];
  return {
    calls,
    recorded,
    deps: {
      registry: {
        findByName: vi.fn(() => sourceEntry),
        findByPath: vi.fn(() => sourceEntry),
        get: vi.fn(() => sourceEntry),
        record: vi.fn((e: Record<string, unknown>) => recorded.push(e)),
        setName: vi.fn(),
        setWorktreeProvenance: vi.fn(),
        remove: vi.fn(() => true),
        listWorktrees: vi.fn(() => []),
        findWorktree: vi.fn(() => null),
      },
      qdrant: {
        aliases: { resolveActive: vi.fn(async () => "code_src_v1") },
        listCollections: vi.fn(async () => []),
      },
      footprintFactory: {
        build: vi.fn(() => ({
          context: { source: {}, target: { logicalName: "code_dst" } },
          artifacts: ["qdrant", "codegraph", "snapshot", "stats", "quarantine"].map((id) =>
            fakeArtifact(id, calls, failOn),
          ),
        })),
      },
      dataDir: "/data",
      ...over,
    } as never,
  };
}

describe("WorktreeOps.create saga", () => {
  it("clones all artifacts then commits the registry entry with provenance", async () => {
    const { deps, calls, recorded } = makeDeps();
    const ops = new WorktreeOps(deps);
    const res = await ops.create({ name: "x", createGit: false });
    expect(calls).toEqual([
      "clone:qdrant",
      "clone:codegraph",
      "clone:snapshot",
      "clone:stats",
      "clone:quarantine",
    ]);
    expect(recorded).toHaveLength(1);
    expect(deps.registry.setWorktreeProvenance).toHaveBeenCalled();
    expect(res.alias).toContain("worktree-x");
  });

  it("rolls back already-cloned artifacts in reverse on failure and does NOT record", async () => {
    const { deps, calls, recorded } = makeDeps({}, [], "snapshot");
    const ops = new WorktreeOps(deps);
    await expect(ops.create({ name: "x", createGit: false })).rejects.toThrow(/boom snapshot/);
    expect(calls).toEqual([
      "clone:qdrant",
      "clone:codegraph",
      "clone:snapshot",
      "remove:codegraph", // reverse of successfully-cloned (snapshot failed mid-clone)
      "remove:qdrant",
    ]);
    expect(recorded).toHaveLength(0);
  });
});

describe("WorktreeOps.remove guard", () => {
  it("refuses to remove an entry without worktree provenance", async () => {
    const { deps } = makeDeps({
      registry: { findWorktree: vi.fn(() => null) },
    });
    const ops = new WorktreeOps(deps);
    await expect(ops.remove({ name: "real-project", force: false, keepGit: true })).rejects.toThrow(
      /not a worktree/i,
    );
  });
});
