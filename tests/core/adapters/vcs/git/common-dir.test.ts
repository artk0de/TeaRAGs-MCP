/**
 * `resolveGitCommonDir` — the repo-identity primitive behind the git cache key.
 *
 * A linked worktree and its main checkout are two working trees over ONE object
 * database. Keying the blame / discovery caches by working tree gave every
 * worktree a cold namespace and re-blamed files whose blob OID never changed.
 * The pin: both trees resolve to the SAME common dir, a plain checkout resolves
 * to its own `.git`, and a non-repo path falls back to itself (so callers keep
 * the pre-fix behaviour when git is unavailable).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveGitCommonDir } from "../../../../../src/core/adapters/vcs/git/common-dir.js";

const TEST_TIMEOUT = 60000;

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("resolveGitCommonDir", () => {
  let root: string;
  let mainCheckout: string;
  let linkedWorktree: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "common-dir-"));
    mainCheckout = join(root, "main");
    linkedWorktree = join(root, "wt");
    mkdirSync(mainCheckout, { recursive: true });

    git(["init", "-b", "master"], mainCheckout);
    git(["config", "user.email", "test@example.com"], mainCheckout);
    git(["config", "user.name", "Test"], mainCheckout);
    writeFileSync(join(mainCheckout, "a.txt"), "one\n");
    git(["add", "-A"], mainCheckout);
    git(["commit", "-m", "first"], mainCheckout);
    git(["worktree", "add", "--detach", linkedWorktree, "HEAD"], mainCheckout);
  }, TEST_TIMEOUT);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a linked worktree to the SAME common dir as its main checkout", () => {
    expect(resolveGitCommonDir(linkedWorktree)).toBe(resolveGitCommonDir(mainCheckout));
  });

  it("resolves a main checkout to its own absolute .git directory", () => {
    // git reports a realpath — on macOS the tmpdir reaches it via /var -> /private/var.
    expect(resolveGitCommonDir(mainCheckout)).toBe(join(realpathSync(mainCheckout), ".git"));
  });

  it("falls back to the given path when it is not a git repository", () => {
    const outsider = mkdtempSync(join(tmpdir(), "common-dir-plain-"));
    try {
      expect(resolveGitCommonDir(outsider)).toBe(outsider);
    } finally {
      rmSync(outsider, { recursive: true, force: true });
    }
  });
});
