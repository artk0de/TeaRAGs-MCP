import { describe, expect, it, vi } from "vitest";
import { WorktreeOps } from "../../../../src/core/domains/maintenance/worktree/worktree-ops.js";
import {
  WorktreeCollectionExistsError,
  WorktreeNotFoundError,
  WorktreeSourceNotFoundError,
} from "../../../../src/core/domains/maintenance/errors.js";

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
        get: vi.fn(() => null),
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

  it("rolls back ALL artifacts including the failing one in reverse on failure", async () => {
    // C2: the failing artifact (snapshot) must participate in rollback
    const { deps, calls, recorded } = makeDeps({}, [], "snapshot");
    const ops = new WorktreeOps(deps);
    await expect(ops.create({ name: "x", createGit: false })).rejects.toThrow(/boom snapshot/);
    expect(calls).toEqual([
      "clone:qdrant",
      "clone:codegraph",
      "clone:snapshot",
      "remove:snapshot", // failing artifact participates in rollback
      "remove:codegraph",
      "remove:qdrant",
    ]);
    expect(recorded).toHaveLength(0);
  });

  it("throws WorktreeCollectionExistsError if the target collection already exists, before any clone", async () => {
    // I1: typed error for target-exists guard
    const calls: string[] = [];
    const { deps } = makeDeps({}, calls);
    deps.registry.get = vi.fn(() => ({ collectionName: "code_dst" }));
    const ops = new WorktreeOps(deps);
    await expect(ops.create({ name: "x", createGit: false })).rejects.toThrow(WorktreeCollectionExistsError);
    await expect(ops.create({ name: "x", createGit: false })).rejects.toThrow(/already exists/);
    expect(calls).toEqual([]);
  });

  it("throws WorktreeSourceNotFoundError when source project is not found", async () => {
    // I1: typed error for source-not-found guard
    const { deps } = makeDeps();
    deps.registry.findByName = vi.fn(() => null);
    deps.registry.findByPath = vi.fn(() => null);
    const ops = new WorktreeOps(deps);
    await expect(ops.create({ name: "x", from: "missing", createGit: false })).rejects.toThrow(
      WorktreeSourceNotFoundError,
    );
    await expect(ops.create({ name: "x", from: "missing", createGit: false })).rejects.toThrow(
      /Source project not found/,
    );
  });
});

describe("WorktreeOps.create with git (C1)", () => {
  it("calls injected removeGitWorktree when gitCreated=true and artifact clone fails", async () => {
    const calls: string[] = [];
    const removeGitWorktree = vi.fn();
    const ensureGitWorktree = vi.fn(() => true); // returns true = worktree was created

    const { deps } = makeDeps({}, calls, "qdrant");
    const ops = new WorktreeOps({
      ...deps,
      ensureGitWorktree,
      removeGitWorktree,
    } as never);

    await expect(ops.create({ name: "x", createGit: true })).rejects.toThrow(/boom qdrant/);
    expect(ensureGitWorktree).toHaveBeenCalled();
    // worktree was created → must be rolled back
    expect(removeGitWorktree).toHaveBeenCalledWith("/repo", expect.any(String), true);
  });

  it("does NOT call removeGitWorktree when gitCreated=false (attach path) and artifact fails", async () => {
    const calls: string[] = [];
    const removeGitWorktree = vi.fn();
    const ensureGitWorktree = vi.fn(() => false); // returns false = attached to existing dir

    const { deps } = makeDeps({}, calls, "qdrant");
    const ops = new WorktreeOps({
      ...deps,
      ensureGitWorktree,
      removeGitWorktree,
    } as never);

    await expect(ops.create({ name: "x", createGit: true })).rejects.toThrow(/boom qdrant/);
    expect(ensureGitWorktree).toHaveBeenCalled();
    // was not created (attached) → must NOT be removed
    expect(removeGitWorktree).not.toHaveBeenCalled();
  });

  it("does NOT call removeGitWorktree when createGit=false and artifact fails", async () => {
    const calls: string[] = [];
    const removeGitWorktree = vi.fn();
    const ensureGitWorktree = vi.fn(() => false);

    const { deps } = makeDeps({}, calls, "qdrant");
    const ops = new WorktreeOps({
      ...deps,
      ensureGitWorktree,
      removeGitWorktree,
    } as never);

    await expect(ops.create({ name: "x", createGit: false })).rejects.toThrow(/boom qdrant/);
    expect(ensureGitWorktree).not.toHaveBeenCalled();
    expect(removeGitWorktree).not.toHaveBeenCalled();
  });
});

describe("WorktreeOps.remove guard", () => {
  it("throws WorktreeNotFoundError when entry has no worktree provenance", async () => {
    // I1: typed error for remove guard
    const { deps } = makeDeps({
      registry: { findWorktree: vi.fn(() => null) },
    });
    const ops = new WorktreeOps(deps);
    await expect(ops.remove({ name: "real-project", force: false, keepGit: true })).rejects.toThrow(
      WorktreeNotFoundError,
    );
    await expect(ops.remove({ name: "real-project", force: false, keepGit: true })).rejects.toThrow(
      /not a worktree/i,
    );
  });
});
