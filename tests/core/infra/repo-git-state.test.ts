import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectDefaultBranch, readRepoGitState, readWorkingTreeDirty } from "../../../src/core/infra/repo-git-state.js";

const created: string[] = [];

function writeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-git-state-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "norepo-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readRepoGitState", () => {
  it("reads branch + commit from a loose ref file", () => {
    const dir = writeRepo({
      ".git/HEAD": "ref: refs/heads/master\n",
      ".git/refs/heads/master": "abc123def\n",
    });
    expect(readRepoGitState(dir)).toEqual({ branch: "master", commit: "abc123def", transient: false });
  });

  it("resolves the ref through packed-refs when no loose ref exists", () => {
    const dir = writeRepo({
      ".git/HEAD": "ref: refs/heads/feature-x\n",
      ".git/packed-refs": "# pack-refs with: peeled fully-peeled sorted\nabc999 refs/heads/feature-x\n",
    });
    expect(readRepoGitState(dir)?.commit).toBe("abc999");
    expect(readRepoGitState(dir)?.branch).toBe("feature-x");
  });

  it("unborn branch (HEAD ref with no commit yet) resolves to empty commit", () => {
    const dir = writeRepo({ ".git/HEAD": "ref: refs/heads/master\n" });
    expect(readRepoGitState(dir)).toEqual({ branch: "master", commit: "", transient: false });
  });

  it("detached HEAD → branch null, sha as commit", () => {
    const dir = writeRepo({ ".git/HEAD": "abc123def4567890\n" });
    expect(readRepoGitState(dir)).toEqual({ branch: null, commit: "abc123def4567890", transient: false });
  });

  it("MERGE_HEAD marks the state transient", () => {
    const dir = writeRepo({
      ".git/HEAD": "ref: refs/heads/master\n",
      ".git/refs/heads/master": "abc\n",
      ".git/MERGE_HEAD": "def\n",
    });
    expect(readRepoGitState(dir)?.transient).toBe(true);
  });

  it("rebase-merge directory marks the state transient", () => {
    const dir = writeRepo({
      ".git/HEAD": "ref: refs/heads/master\n",
      ".git/refs/heads/master": "abc\n",
      ".git/rebase-merge/head-name": "refs/heads/master\n",
    });
    expect(readRepoGitState(dir)?.transient).toBe(true);
  });

  it("BISECT_LOG marks the state transient", () => {
    const dir = writeRepo({
      ".git/HEAD": "abc123\n",
      ".git/BISECT_LOG": "git bisect start\n",
    });
    expect(readRepoGitState(dir)?.transient).toBe(true);
  });

  it("worktree .git FILE indirection resolves via gitdir + commondir", () => {
    const main = writeRepo({ ".git/packed-refs": "abc123 refs/heads/master\n" });
    const wtGitdir = join(main, ".git", "worktrees", "wt1");
    mkdirSync(wtGitdir, { recursive: true });
    writeFileSync(join(wtGitdir, "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(wtGitdir, "commondir"), "../..\n");
    const wt = emptyDir();
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGitdir}\n`);
    expect(readRepoGitState(wt)).toEqual({ branch: "master", commit: "abc123", transient: false });
  });

  it("worktree MERGE_HEAD lives in the per-worktree gitdir", () => {
    const main = writeRepo({ ".git/packed-refs": "abc123 refs/heads/master\n" });
    const wtGitdir = join(main, ".git", "worktrees", "wt2");
    mkdirSync(wtGitdir, { recursive: true });
    writeFileSync(join(wtGitdir, "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(wtGitdir, "commondir"), "../..\n");
    writeFileSync(join(wtGitdir, "MERGE_HEAD"), "def\n");
    const wt = emptyDir();
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGitdir}\n`);
    expect(readRepoGitState(wt)?.transient).toBe(true);
  });

  it("returns null for a directory that is not a git repo", () => {
    expect(readRepoGitState(emptyDir())).toBeNull();
  });

  it("returns null and never throws on unreadable/corrupt .git", () => {
    const dir = writeRepo({ ".git/HEAD": "" });
    expect(readRepoGitState(dir)).toBeNull();
  });
});

describe("readWorkingTreeDirty", () => {
  it("true on non-empty porcelain output", () => {
    expect(readWorkingTreeDirty("/x", (() => " M a.ts\n") as never)).toBe(true);
  });

  it("false on empty porcelain output", () => {
    expect(readWorkingTreeDirty("/x", (() => "") as never)).toBe(false);
  });

  it("false (conservative) when git spawn fails", () => {
    expect(
      readWorkingTreeDirty("/x", (() => {
        throw new Error("no git");
      }) as never),
    ).toBe(false);
  });
});

describe("detectDefaultBranch", () => {
  it("strips the origin/ prefix from the symref answer", () => {
    expect(detectDefaultBranch("/x", (() => "origin/trunk\n") as never)).toBe("trunk");
  });

  it("falls back to an existing local main ref when origin/HEAD is unset", () => {
    const dir = writeRepo({
      ".git/HEAD": "ref: refs/heads/whatever\n",
      ".git/refs/heads/main": "abc\n",
    });
    expect(
      detectDefaultBranch(dir, (() => {
        throw new Error("no origin");
      }) as never),
    ).toBe("main");
  });

  it("falls back to an existing local master ref when main is absent", () => {
    const dir = writeRepo({
      ".git/HEAD": "ref: refs/heads/whatever\n",
      ".git/refs/heads/master": "abc\n",
    });
    expect(
      detectDefaultBranch(dir, (() => {
        throw new Error("no origin");
      }) as never),
    ).toBe("master");
  });

  it("resolves master through packed-refs too", () => {
    const dir = writeRepo({
      ".git/HEAD": "ref: refs/heads/whatever\n",
      ".git/packed-refs": "abc refs/heads/master\n",
    });
    expect(
      detectDefaultBranch(dir, (() => {
        throw new Error("no origin");
      }) as never),
    ).toBe("master");
  });

  it('final fallback is "main"', () => {
    expect(
      detectDefaultBranch(emptyDir(), (() => {
        throw new Error("no origin");
      }) as never),
    ).toBe("main");
  });
});
