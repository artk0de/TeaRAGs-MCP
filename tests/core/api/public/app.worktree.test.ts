import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../../../src/core/api/public/app.js";

function baseDeps() {
  return {
    qdrant: {},
    embeddings: {},
    ingest: {},
    explore: {},
    reranker: {},
    schemaDriftMonitor: {},
    projectRegistryOps: {},
    quantizationScalar: false,
  } as never;
}

describe("App worktree delegation", () => {
  it("createWorktree delegates to worktreeOps.create", async () => {
    const worktreeOps = {
      create: vi.fn(async () => ({
        collectionName: "code_dst",
        alias: "a",
        sourceProject: "p",
        worktreePath: "/w",
      })),
      list: vi.fn(() => []),
      remove: vi.fn(async () => ({ removed: true })),
      info: vi.fn(() => ({ isWorktree: false })),
    };
    const app = createApp({ ...baseDeps(), worktreeOps } as never);
    const res = await app.createWorktree({ name: "x", createGit: false });
    expect(worktreeOps.create).toHaveBeenCalledWith({ name: "x", createGit: false });
    expect(res.collectionName).toBe("code_dst");
  });

  it("throws when worktreeOps is absent", async () => {
    const app = createApp(baseDeps());
    await expect(app.createWorktree({ name: "x", createGit: false })).rejects.toThrow(
      "worktreeOps is not configured",
    );
  });

  it("listWorktrees delegates to worktreeOps.list", async () => {
    const worktreeOps = {
      create: vi.fn(),
      list: vi.fn(() => [{ isWorktree: true, collectionName: "code_wt" }]),
      remove: vi.fn(),
      info: vi.fn(),
    };
    const app = createApp({ ...baseDeps(), worktreeOps } as never);
    const result = await app.listWorktrees();
    expect(worktreeOps.list).toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it("removeWorktree delegates to worktreeOps.remove", async () => {
    const worktreeOps = {
      create: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(async () => ({ removed: true })),
      info: vi.fn(),
    };
    const app = createApp({ ...baseDeps(), worktreeOps } as never);
    const result = await app.removeWorktree({ name: "wt", force: false, keepGit: false });
    expect(worktreeOps.remove).toHaveBeenCalledWith({ name: "wt", force: false, keepGit: false });
    expect(result.removed).toBe(true);
  });

  it("worktreeInfo delegates to worktreeOps.info", async () => {
    const worktreeOps = {
      create: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
      info: vi.fn(() => ({ isWorktree: true, collectionName: "code_wt" })),
    };
    const app = createApp({ ...baseDeps(), worktreeOps } as never);
    const result = await app.worktreeInfo({ cwd: "/some/path" });
    expect(worktreeOps.info).toHaveBeenCalledWith("/some/path");
    expect(result.isWorktree).toBe(true);
  });
});
