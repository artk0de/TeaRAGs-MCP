/**
 * `GitCliAdapter#isAncestor` asks git once per commit pair (bd
 * tea-rags-mcp-0qaht.51): a warm git-trajectory run tops up BOTH its file-churn
 * and its commit discovery from the prior snapshot's head, and each asked
 * `git merge-base --is-ancestor <prior> <head>` for the same pair — a second
 * child an endpoint-security agent makes cost hundreds of milliseconds. Whether
 * one commit descends from another never changes once both exist, so a "yes"
 * is kept for the adapter's life. A "no" is not: it also stands for a failed
 * child, which the next ask may not repeat. A ref name can move, so only full
 * object names are kept.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type * as ExecModule from "../../../../../../src/core/adapters/vcs/git/git-cli/exec.js";

vi.mock("../../../../../../src/core/adapters/vcs/git/git-cli/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();
  return { ...actual, execFileAsync: vi.fn(actual.execFileAsync) };
});

const exec = await import("../../../../../../src/core/adapters/vcs/git/git-cli/exec.js");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  }).trim();
}

function ancestryChecksAskedOfGit(): number {
  return vi.mocked(exec.execFileAsync).mock.calls.filter(([, args]) => args.includes("--is-ancestor")).length;
}

describe("GitCliAdapter — repeated ancestry checks", { timeout: 30_000 }, () => {
  let repo: string;
  let first: string;
  let second: string;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "ancestry-memo-")));
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.ts"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");
    first = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.ts"), "a\nb\n");
    git(repo, "commit", "-q", "-am", "second");
    second = git(repo, "rev-parse", "HEAD");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.mocked(exec.execFileAsync).mockClear();
  });

  it("asks git once for a commit pair that is an ancestry, however often it is asked", async () => {
    const adapter = new GitCliAdapter(repo);

    const answers = await Promise.all([adapter.isAncestor(first, second), adapter.isAncestor(first, second)]);
    answers.push(await adapter.isAncestor(first, second));

    expect(answers).toEqual([true, true, true]);
    expect(ancestryChecksAskedOfGit()).toBe(1);
  });

  it("asks git again for a pair that is not an ancestry", async () => {
    const adapter = new GitCliAdapter(repo);

    expect(await adapter.isAncestor(second, first)).toBe(false);
    expect(await adapter.isAncestor(second, first)).toBe(false);
    expect(ancestryChecksAskedOfGit()).toBe(2);
  });

  it("asks git again for a ref name, which can move", async () => {
    const adapter = new GitCliAdapter(repo);

    expect(await adapter.isAncestor(first, "HEAD")).toBe(true);
    expect(await adapter.isAncestor(first, "HEAD")).toBe(true);
    expect(ancestryChecksAskedOfGit()).toBe(2);
  });
});
