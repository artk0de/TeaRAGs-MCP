/**
 * `readAddedLineRangesOfFiles` with the caller's untracked listing (bd
 * tea-rags-mcp-0qaht.63): a caller that already listed the tree's untracked
 * files hands that listing over, and the read trusts it instead of spawning a
 * second `git ls-files --others` — a spawn costs hundreds of milliseconds when
 * an endpoint-security agent serializes them. Without a listing the read lists
 * for itself, as `working-tree.test.ts` pins.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAddedLineRangesOfFiles } from "../../../../../../src/core/adapters/vcs/git/git-cli/working-tree.js";

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

describe("git CLI client — added line ranges over a caller's untracked listing", { timeout: 30_000 }, () => {
  let root: string;
  let base: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "added-ranges-listing-"));
    git(root, "init", "-q", "-b", "main");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/edited.ts"), "a\nb\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    base = git(root, "rev-parse", "HEAD").trim();
    writeFileSync(join(root, "src/edited.ts"), "a\nb\nc\n");
    writeFileSync(join(root, "src/new.ts"), "x\ny\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a path the listing names is read whole; every other path is diffed", async () => {
    const ranges = await readAddedLineRangesOfFiles(root, base, ["src/edited.ts", "src/new.ts"], undefined, [
      "src/new.ts",
    ]);

    expect(ranges.get("src/new.ts")).toEqual([{ start: 1, end: 2 }]);
    expect(ranges.get("src/edited.ts")).toEqual([{ start: 3, end: 3 }]);
  });

  it("the listing is trusted as given: a tracked path it names reads whole, with no listing of its own", async () => {
    const ranges = await readAddedLineRangesOfFiles(root, base, ["src/edited.ts"], undefined, ["src/edited.ts"]);

    expect(ranges.get("src/edited.ts")).toEqual([{ start: 1, end: 3 }]);
  });
});
