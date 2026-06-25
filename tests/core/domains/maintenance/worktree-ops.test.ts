import { describe, expect, it, vi } from "vitest";

import {
  WorktreeCollectionExistsError,
  WorktreeNotFoundError,
  WorktreeSourceNotFoundError,
} from "../../../../src/core/domains/maintenance/errors.js";
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
  // Track what footprintFactory.build() was called with for assertion
  const buildCalls: { source: unknown; target: unknown }[] = [];
  return {
    calls,
    recorded,
    buildCalls,
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
        build: vi.fn((source: unknown, target: unknown) => {
          buildCalls.push({ source, target });
          return {
            context: { source: {}, target: { logicalName: "code_dst" } },
            artifacts: ["qdrant", "codegraph", "snapshot", "stats", "quarantine"].map((id) =>
              fakeArtifact(id, calls, failOn),
            ),
          };
        }),
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
    expect(calls).toEqual(["clone:qdrant", "clone:codegraph", "clone:snapshot", "clone:stats", "clone:quarantine"]);
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
    await expect(ops.remove({ name: "real-project", force: false, keepGit: true })).rejects.toThrow(/not a worktree/i);
  });
});

describe("WorktreeOps.list", () => {
  it("returns empty array when registry has no worktrees", () => {
    const { deps } = makeDeps();
    deps.registry.listWorktrees = vi.fn(() => []);
    const ops = new WorktreeOps(deps);
    expect(ops.list()).toEqual([]);
  });

  it("maps registry worktree entries to WorktreeInfo shape", () => {
    const { deps } = makeDeps();
    deps.registry.listWorktrees = vi.fn(() => [
      {
        collectionName: "code_wt",
        worktreeOf: "code_src",
        worktreeName: "feat",
        name: "proj-worktree-feat",
        path: "/wt",
        chunksCount: 12,
        embeddingModel: "j",
        embeddingDimensions: 768,
        qdrantUrl: "http://h",
        indexedAt: "t",
        teaRagsVersion: "1",
      },
    ]);
    const ops = new WorktreeOps(deps);
    const result = ops.list();
    expect(result).toHaveLength(1);
    expect(result[0].isWorktree).toBe(true);
    expect(result[0].collectionName).toBe("code_wt");
    expect(result[0].worktreeOf).toBe("code_src");
    expect(result[0].worktreeName).toBe("feat");
    expect(result[0].alias).toBe("proj-worktree-feat");
    expect(result[0].chunksCount).toBe(12);
  });

  it("uses undefined for alias when entry.name is null/undefined", () => {
    const { deps } = makeDeps();
    deps.registry.listWorktrees = vi.fn(() => [
      {
        collectionName: "code_noalias",
        worktreeOf: "code_src",
        worktreeName: "feat2",
        name: null,
        path: "/wt2",
        chunksCount: 0,
        embeddingModel: "j",
        embeddingDimensions: 768,
        qdrantUrl: "http://h",
        indexedAt: "t",
        teaRagsVersion: "1",
      },
    ]);
    const ops = new WorktreeOps(deps);
    const result = ops.list();
    expect(result[0].alias).toBeUndefined();
  });
});

describe("WorktreeOps.info", () => {
  it("returns isWorktree: false when path is not in registry", () => {
    const { deps } = makeDeps();
    deps.registry.findByPath = vi.fn(() => null);
    const ops = new WorktreeOps(deps);
    expect(ops.info("/some/path")).toEqual({ isWorktree: false });
  });

  it("returns isWorktree: false when entry has no worktreeOf", () => {
    const { deps } = makeDeps();
    // findByPath returns an entry without worktreeOf
    deps.registry.findByPath = vi.fn(() => ({
      collectionName: "code_reg",
      worktreeOf: undefined,
      name: "regular",
      path: "/repo",
      chunksCount: 10,
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      indexedAt: "t",
      teaRagsVersion: "1",
    }));
    const ops = new WorktreeOps(deps);
    expect(ops.info("/repo")).toEqual({ isWorktree: false });
  });

  it("returns full worktree info when path matches a worktree entry", () => {
    const { deps } = makeDeps();
    deps.registry.findByPath = vi.fn(() => ({
      collectionName: "code_wt",
      worktreeOf: "code_src",
      worktreeName: "feat",
      name: "proj-worktree-feat",
      path: "/wt",
      chunksCount: 5,
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      indexedAt: "t",
      teaRagsVersion: "1",
    }));
    const ops = new WorktreeOps(deps);
    const info = ops.info("/wt");
    expect(info.isWorktree).toBe(true);
    expect(info.collectionName).toBe("code_wt");
    expect(info.worktreeOf).toBe("code_src");
    expect(info.alias).toBe("proj-worktree-feat");
    expect(info.chunksCount).toBe(5);
  });
});

describe("WorktreeOps.remove with git cleanup", () => {
  it("calls removeGitWorktree when keepGit is false and source repo root is known", async () => {
    const worktreeEntry = {
      collectionName: "code_dst",
      worktreeOf: "code_src",
      worktreeName: "feat",
      path: "/wt",
      name: "proj-worktree-feat",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      codegraphEnabled: false,
    };
    const sourceEntry = {
      collectionName: "code_src",
      path: "/repo",
      name: "proj",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
    };
    const removeGitWorktree = vi.fn();
    const { deps } = makeDeps();
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    deps.registry.get = vi.fn(() => sourceEntry);
    deps.qdrant.aliases.resolveActive = vi.fn(async () => "code_src_v1");

    const ops = new WorktreeOps({ ...deps, removeGitWorktree } as never);
    const result = await ops.remove({ name: "feat", force: false, keepGit: false });

    expect(result.removed).toBe(true);
    expect(removeGitWorktree).toHaveBeenCalledWith("/repo", "/wt", false);
  });

  it("does NOT call removeGitWorktree when keepGit is true", async () => {
    const worktreeEntry = {
      collectionName: "code_dst",
      worktreeOf: "code_src",
      worktreeName: "feat",
      path: "/wt",
      name: "proj-worktree-feat",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      codegraphEnabled: false,
    };
    const removeGitWorktree = vi.fn();
    const { deps } = makeDeps();
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    deps.registry.get = vi.fn(() => ({ path: "/repo" }));
    deps.qdrant.aliases.resolveActive = vi.fn(async () => "code_src_v1");

    const ops = new WorktreeOps({ ...deps, removeGitWorktree } as never);
    await ops.remove({ name: "feat", force: true, keepGit: true });

    expect(removeGitWorktree).not.toHaveBeenCalled();
  });

  it("does NOT call removeGitWorktree when source repo root is not found in registry", async () => {
    const worktreeEntry = {
      collectionName: "code_dst",
      worktreeOf: "code_src",
      worktreeName: "feat",
      path: "/wt",
      name: "proj-worktree-feat",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      codegraphEnabled: false,
    };
    const removeGitWorktree = vi.fn();
    const { deps } = makeDeps();
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    deps.registry.get = vi.fn(() => null); // source not found
    deps.qdrant.aliases.resolveActive = vi.fn(async () => "code_src_v1");

    const ops = new WorktreeOps({ ...deps, removeGitWorktree } as never);
    await ops.remove({ name: "feat", force: false, keepGit: false });

    expect(removeGitWorktree).not.toHaveBeenCalled();
  });
});

describe("WorktreeOps.remove physical resolution", () => {
  it("uses resolveActive result as target physicalName, not hardcoded _v1", async () => {
    // Bug 2: after a reindex the active physical may be _v2+; remove must NOT hardcode _v1
    const worktreeEntry = {
      collectionName: "code_dst",
      worktreeOf: "code_src",
      worktreeName: "feat",
      path: "/wt",
      name: "proj-worktree-feat",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      codegraphEnabled: true,
    };
    const { deps, buildCalls } = makeDeps();
    // Stub findWorktree to return a worktree entry
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    // resolveActive returns _v2 for the TARGET collection (simulating post-reindex state)
    deps.qdrant.aliases.resolveActive = vi.fn(async (name: string) => {
      if (name === "code_src") return "code_src_v1";
      if (name === "code_dst") return "code_dst_v2";
      return `${name}_v1`;
    });

    const ops = new WorktreeOps(deps);
    await ops.remove({ name: "feat", force: false, keepGit: true });

    // footprintFactory.build must receive target with physicalName = "code_dst_v2"
    expect(buildCalls).toHaveLength(1);
    expect((buildCalls[0].target as { physicalName: string }).physicalName).toBe("code_dst_v2");
  });

  it("falls back to _v1 when resolveActive throws for the target", async () => {
    const worktreeEntry = {
      collectionName: "code_dst",
      worktreeOf: "code_src",
      worktreeName: "feat",
      path: "/wt",
      name: "proj-worktree-feat",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      codegraphEnabled: false,
    };
    const { deps, buildCalls } = makeDeps();
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    deps.qdrant.aliases.resolveActive = vi.fn(async (name: string) => {
      if (name === "code_src") return "code_src_v1";
      throw new Error("collection not found");
    });

    const ops = new WorktreeOps(deps);
    await ops.remove({ name: "feat", force: false, keepGit: true });

    expect(buildCalls).toHaveLength(1);
    expect((buildCalls[0].target as { physicalName: string }).physicalName).toBe("code_dst_v1");
  });
});
