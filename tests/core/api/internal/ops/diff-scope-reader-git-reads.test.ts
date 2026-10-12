/**
 * `readDiffScope`'s git-read economy (bd tea-rags-mcp-0qaht.63): every git
 * child costs a process spawn, and an endpoint-security agent serializes those
 * machine-wide (260 ms for `/bin/echo` under load, no parallel scaling), so a
 * read the reader can answer without git must not spawn one. What is pinned
 * here is WHICH adapter reads run, not what they return — the answers are
 * `diff-scope-reader.test.ts`'s, against the same kind of temp repository.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyGitRepoTemplate } from "../../../__helpers__/git-repo-template.js";
import type * as VcsModule from "../../../../../src/core/adapters/vcs/index.js";
import { readDiffScope } from "../../../../../src/core/api/internal/ops/diff-scope-reader.js";

vi.mock("../../../../../src/core/adapters/vcs/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof VcsModule>();
  return {
    ...actual,
    readMergeBase: vi.fn(actual.readMergeBase),
    listCommitsSince: vi.fn(actual.listCommitsSince),
    readAddedLineRangesOfFiles: vi.fn(actual.readAddedLineRangesOfFiles),
  };
});

const vcs = await import("../../../../../src/core/adapters/vcs/index.js");

const CHANGED = "src/a.ts";

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
  });
}

describe("readDiffScope — git reads it can answer without git", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = realpathSync(
      copyGitRepoTemplate(
        "diff-scope-reader-git-reads:init",
        (root) => {
          const built = join(root, "repo");
          mkdirSync(join(built, "src"), { recursive: true });
          git(built, "init", "-q", "-b", "main");
          git(built, "config", "maintenance.auto", "false");
          writeFileSync(join(built, CHANGED), "export const a = 1;\n");
          git(built, "add", "-A");
          git(built, "commit", "-q", "-m", "init");
        },
        { prefix: "diff-scope-reader-git-reads-", refreshIndex: false },
      ).root,
    );
    repo = join(dir, "repo");
    writeFileSync(join(repo, CHANGED), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(join(repo, "src/new.ts"), "export const n = 1;\n");
    vi.mocked(vcs.readMergeBase).mockClear();
    vi.mocked(vcs.listCommitsSince).mockClear();
    vi.mocked(vcs.readAddedLineRangesOfFiles).mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("the default base is HEAD: its commit is read from the repository, not asked of git, and the change has no commits of its own", async () => {
    const read = await readDiffScope(repo, {});

    expect(read.mergeBase).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(read.diffCommits).toEqual([]);
    expect(vcs.readMergeBase).not.toHaveBeenCalled();
    expect(vcs.listCommitsSince).not.toHaveBeenCalled();
  });

  it("an explicit base still resolves through git; a merge-base at HEAD lists no commits", async () => {
    const head = git(repo, "rev-parse", "HEAD").trim();

    const read = await readDiffScope(repo, { base: "main" });

    expect(read.mergeBase).toBe(head);
    expect(read.diffCommits).toEqual([]);
    expect(vcs.readMergeBase).toHaveBeenCalledTimes(1);
    expect(vcs.listCommitsSince).not.toHaveBeenCalled();
  });

  it("a base behind HEAD lists the change's own commits through git", async () => {
    const base = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "change");
    const head = git(repo, "rev-parse", "HEAD").trim();

    const read = await readDiffScope(repo, { base });

    expect(read.mergeBase).toBe(base);
    expect(read.diffCommits).toEqual([head]);
    expect(vcs.listCommitsSince).toHaveBeenCalledTimes(1);
  });

  it("the added-line read reuses the change's untracked listing instead of listing again", async () => {
    const read = await readDiffScope(repo, {});

    expect(read.addedRanges.get("src/new.ts")).toEqual([{ start: 1, end: 1 }]);
    const [, , , , untrackedListing] = vi.mocked(vcs.readAddedLineRangesOfFiles).mock.calls[0];
    expect(untrackedListing).toEqual(["src/new.ts"]);
  });
});
