import { describe, expect, it, vi } from "vitest";

import {
  listWorktreeInfos,
  toWorktreeInfo,
  worktreeInfoForPath,
  WorktreeOps,
} from "../../../../../src/core/api/internal/ops/worktree-ops.js";
import type { WorktreeProvisioner } from "../../../../../src/core/domains/maintenance/worktree/index.js";

type RegistryLike = Parameters<typeof listWorktreeInfos>[0];

describe("WorktreeOps facade", () => {
  it("delegates create to the provisioner", async () => {
    const provisioner = {
      create: vi.fn(async () => ({
        collectionName: "code_dst",
        alias: "proj-worktree-x",
        sourceProject: "proj",
        worktreePath: "/wt",
      })),
      remove: vi.fn(),
    } as unknown as WorktreeProvisioner;
    const ops = new WorktreeOps(provisioner);
    const input = { name: "x", createGit: false };
    const res = await ops.create(input);
    expect(provisioner.create).toHaveBeenCalledWith(input);
    expect(res.alias).toBe("proj-worktree-x");
  });

  it("delegates remove to the provisioner", async () => {
    const provisioner = {
      create: vi.fn(),
      remove: vi.fn(async () => ({ removed: true })),
    } as unknown as WorktreeProvisioner;
    const ops = new WorktreeOps(provisioner);
    const input = { name: "feat", force: true, keepGit: false };
    const res = await ops.remove(input);
    expect(provisioner.remove).toHaveBeenCalledWith(input);
    expect(res.removed).toBe(true);
  });
});

describe("listWorktreeInfos", () => {
  it("returns empty array when registry has no worktrees", () => {
    const registry = { listWorktrees: vi.fn(() => []) } as unknown as RegistryLike;
    expect(listWorktreeInfos(registry)).toEqual([]);
  });

  it("maps registry worktree entries to WorktreeInfo shape", () => {
    const registry = {
      listWorktrees: vi.fn(() => [
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
      ]),
    } as unknown as RegistryLike;
    const result = listWorktreeInfos(registry);
    expect(result).toHaveLength(1);
    expect(result[0].isWorktree).toBe(true);
    expect(result[0].collectionName).toBe("code_wt");
    expect(result[0].worktreeOf).toBe("code_src");
    expect(result[0].worktreeName).toBe("feat");
    expect(result[0].alias).toBe("proj-worktree-feat");
    expect(result[0].chunksCount).toBe(12);
  });

  it("uses undefined for alias when entry.name is null/undefined", () => {
    const registry = {
      listWorktrees: vi.fn(() => [
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
      ]),
    } as unknown as RegistryLike;
    expect(listWorktreeInfos(registry)[0].alias).toBeUndefined();
  });
});

describe("worktreeInfoForPath", () => {
  it("returns isWorktree: false when path is not in registry", () => {
    const registry = { findByPath: vi.fn(() => null) } as unknown as RegistryLike;
    expect(worktreeInfoForPath(registry, "/some/path")).toEqual({ isWorktree: false });
  });

  it("returns isWorktree: false when entry has no worktreeOf", () => {
    const registry = {
      findByPath: vi.fn(() => ({
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
      })),
    } as unknown as RegistryLike;
    expect(worktreeInfoForPath(registry, "/repo")).toEqual({ isWorktree: false });
  });

  it("returns full worktree info when path matches a worktree entry", () => {
    const registry = {
      findByPath: vi.fn(() => ({
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
      })),
    } as unknown as RegistryLike;
    const info = worktreeInfoForPath(registry, "/wt");
    expect(info.isWorktree).toBe(true);
    expect(info.collectionName).toBe("code_wt");
    expect(info.worktreeOf).toBe("code_src");
    expect(info.alias).toBe("proj-worktree-feat");
    expect(info.chunksCount).toBe(5);
  });
});

describe("toWorktreeInfo", () => {
  it("maps a single entry, defaulting alias to undefined when name is null", () => {
    const info = toWorktreeInfo({
      collectionName: "code_wt",
      worktreeOf: "code_src",
      worktreeName: "feat",
      name: null,
      path: "/wt",
      chunksCount: 3,
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      indexedAt: "t",
      teaRagsVersion: "1",
    } as never);
    expect(info).toEqual({
      isWorktree: true,
      collectionName: "code_wt",
      alias: undefined,
      worktreeOf: "code_src",
      worktreeName: "feat",
      chunksCount: 3,
    });
  });
});
