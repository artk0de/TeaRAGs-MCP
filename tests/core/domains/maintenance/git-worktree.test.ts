/**
 * ensureGitWorktree / removeGitWorktree behavioral pin against REAL git.
 * The low-level worktree add/remove wrapper is otherwise only reached through
 * worktree-provisioner (which mocks it), so its real git-invoking body is
 * exercised here directly (precedent: churn-walk-thread / client-catfile real
 * git fixtures). Worktrees live in a sibling temp dir, never inside the repo.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureGitWorktree, removeGitWorktree } from "../../../../src/core/domains/maintenance/worktree/git-worktree.js";

const TMP_BASE = realpathSync(tmpdir());
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  // A worktree add needs at least one commit (no unborn-branch checkout).
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], { cwd: dir, env: { ...process.env, ...AUTHOR_ENV } });
}

function branchExists(repo: string, branch: string): boolean {
  return execFileSync("git", ["-C", repo, "branch", "--list", branch], { encoding: "utf8" }).includes(branch);
}

describe("ensureGitWorktree / removeGitWorktree (real git)", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(TMP_BASE, "gwt-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    initRepo(repo);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a new worktree on a name-derived branch and force-removes it", () => {
    const target = join(root, "wt-a");

    const created = ensureGitWorktree(repo, "feature-a", target);

    expect(created).toBe(true);
    expect(existsSync(join(target, ".git"))).toBe(true);
    expect(branchExists(repo, "feature-a")).toBe(true); // branch defaults to `name`

    removeGitWorktree(repo, target, true);
    expect(existsSync(target)).toBe(false);
  });

  it("honors an explicit branch over the name default and removes without force", () => {
    const target = join(root, "wt-b");

    const created = ensureGitWorktree(repo, "ignored-name", target, "explicit-branch");

    expect(created).toBe(true);
    expect(branchExists(repo, "explicit-branch")).toBe(true);
    expect(branchExists(repo, "ignored-name")).toBe(false);

    // A pristine worktree removes cleanly without --force.
    removeGitWorktree(repo, target, false);
    expect(existsSync(target)).toBe(false);
  });

  it("is idempotent: returns false and never invokes git when the target already exists", () => {
    const target = join(root, "wt-existing");
    mkdirSync(target);

    expect(ensureGitWorktree(repo, "whatever", target)).toBe(false);
    // No worktree was registered for the pre-existing dir.
    expect(branchExists(repo, "whatever")).toBe(false);
  });
});
