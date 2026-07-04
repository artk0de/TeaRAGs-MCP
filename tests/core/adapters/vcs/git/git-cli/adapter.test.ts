import { describe, expect, it } from "vitest";

import { VcsGitAdapter } from "../../../../../../src/core/adapters/vcs/git/adapter.js";
import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";

describe("GitCliAdapter", () => {
  it("is a VcsGitAdapter bound to a repo root", () => {
    const adapter = new GitCliAdapter(process.cwd());
    expect(adapter).toBeInstanceOf(VcsGitAdapter);
    expect(adapter.repoRoot).toBe(process.cwd());
  });

  it("getHead delegates to the git CLI (real repo)", async () => {
    const adapter = new GitCliAdapter(process.cwd());
    await expect(adapter.getHead()).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it("blameFile returns [] for an untracked path (CLI contract)", async () => {
    const adapter = new GitCliAdapter(process.cwd());
    await expect(adapter.blameFile("no/such/file.xyz")).resolves.toEqual([]);
  });

  it("batch readers are constructed lazily without spawning git", async () => {
    const adapter = new GitCliAdapter(process.cwd());
    const reader = adapter.createBlobBatchReader();
    const resolver = adapter.createOidBatchResolver();
    await reader.close();
    await resolver.close();
  });
});
