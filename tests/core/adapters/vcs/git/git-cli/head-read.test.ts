/**
 * Where the git CLI client reads HEAD (bd tea-rags-mcp-0qaht.51): from the
 * repository's own files — `HEAD`, the loose ref or `packed-refs` it names, a
 * linked worktree's per-worktree gitdir — instead of a `git rev-parse HEAD`
 * child per read. An endpoint-security agent serializes every process exec on
 * this machine (hundreds of milliseconds each under load), and a git-trajectory
 * run read HEAD three times serially. Git is still asked whenever the files
 * cannot answer as git would: an environment that redirects it (`GIT_DIR`, …),
 * a root that holds no `.git` of its own, an unborn branch.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { getHead } from "../../../../../../src/core/adapters/vcs/git/git-cli/client.js";
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

function headReadsAskedOfGit(): number {
  return vi.mocked(exec.execFileAsync).mock.calls.filter(([, args]) => args.includes("rev-parse")).length;
}

describe("git CLI client — reading HEAD", { timeout: 30_000 }, () => {
  let root: string;
  let main: string;
  let linked: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "head-read-")));
    main = join(root, "main");
    linked = join(root, "linked");
    mkdirSync(join(main, "src"), { recursive: true });
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, "src/a.ts"), "a\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "init");
    git(main, "worktree", "add", "-q", "-b", "feature", linked);
    writeFileSync(join(linked, "src/b.ts"), "b\n");
    git(linked, "add", "-A");
    git(linked, "commit", "-q", "-m", "feature");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.mocked(exec.execFileAsync).mockClear();
    vi.unstubAllEnvs();
  });

  it("a main checkout's HEAD is read from its .git directory, without asking git", async () => {
    await expect(getHead(main)).resolves.toBe(git(main, "rev-parse", "HEAD"));
    expect(headReadsAskedOfGit()).toBe(0);
  });

  it("a linked worktree's HEAD is its own branch's commit, read from the gitdir its .git file names", async () => {
    const head = git(linked, "rev-parse", "HEAD");

    await expect(getHead(linked)).resolves.toBe(head);
    expect(head).not.toBe(git(main, "rev-parse", "HEAD"));
    expect(headReadsAskedOfGit()).toBe(0);
  });

  it("a branch whose ref lives only in packed-refs is resolved there", async () => {
    const repo = join(root, "packed");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.ts"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "pack-refs", "--all");

    await expect(getHead(repo)).resolves.toBe(git(repo, "rev-parse", "HEAD"));
    expect(headReadsAskedOfGit()).toBe(0);
  });

  it("a detached HEAD names its commit itself", async () => {
    const repo = join(root, "detached");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.ts"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "checkout", "-q", "--detach");

    await expect(getHead(repo)).resolves.toBe(git(repo, "rev-parse", "HEAD"));
    expect(headReadsAskedOfGit()).toBe(0);
  });

  it("asks git when the environment redirects it", async () => {
    vi.stubEnv("GIT_DIR", join(main, ".git"));

    await expect(getHead(linked)).resolves.toBe(git(main, "rev-parse", "HEAD"));
    expect(headReadsAskedOfGit()).toBe(1);
  });

  it("asks git for a root below the toplevel, which holds no .git of its own", async () => {
    await expect(getHead(join(main, "src"))).resolves.toBe(git(main, "rev-parse", "HEAD"));
    expect(headReadsAskedOfGit()).toBe(1);
  });

  it("asks git for an unborn branch, and fails as git does", async () => {
    const repo = join(root, "unborn");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");

    await expect(getHead(repo)).rejects.toThrow();
    expect(headReadsAskedOfGit()).toBe(1);
  });
});
