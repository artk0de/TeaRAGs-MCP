/**
 * The two reads a naming review over a diff scopes itself by (bd
 * tea-rags-mcp-fdef2): which files the working tree changed against a base
 * (tracked edits, staged or not, plus untracked files), and which lines of one
 * such file the change ADDED. A deletion adds nothing; an untracked file is
 * added whole.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  listChangedFiles,
  readAddedLineRanges,
  readAddedLineRangesOfFiles,
  readMergeBase,
} from "../../../../../../src/core/adapters/vcs/git/git-cli/client.js";

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

function numberedLines(count: number, label: string): string {
  return `${Array.from({ length: count }, (_, i) => `${label} ${i + 1}`).join("\n")}\n`;
}

describe("git CLI client — changed files and added line ranges", { timeout: 30_000 }, () => {
  let root: string;
  let base: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "changed-lines-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@x");
    git(root, "config", "user.name", "t");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/edited.ts"), numberedLines(9, "line"));
    writeFileSync(join(root, "src/shrunk.ts"), numberedLines(6, "line"));
    writeFileSync(join(root, "src/staged.ts"), numberedLines(2, "line"));
    writeFileSync(join(root, "src/untouched.ts"), numberedLines(3, "line"));
    writeFileSync(join(root, "src/gone.ts"), numberedLines(3, "line"));
    writeFileSync(join(root, ".gitignore"), "build/\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    base = git(root, "rev-parse", "HEAD").trim();

    // Line 3 rewritten, lines 10–12 appended.
    const edited = numberedLines(9, "line").split("\n");
    edited[2] = "rewritten 3";
    writeFileSync(join(root, "src/edited.ts"), `${edited.slice(0, 9).join("\n")}\n${numberedLines(3, "appended")}`);
    // Lines 2–3 removed and nothing added.
    const shrunk = numberedLines(6, "line").split("\n");
    writeFileSync(join(root, "src/shrunk.ts"), `${[shrunk[0], ...shrunk.slice(3, 6)].join("\n")}\n`);
    // A staged edit counts as much as an unstaged one.
    writeFileSync(join(root, "src/staged.ts"), `${numberedLines(2, "line")}staged 3\n`);
    git(root, "add", "src/staged.ts");
    unlinkSync(join(root, "src/gone.ts"));
    writeFileSync(join(root, "src/fresh.ts"), numberedLines(4, "fresh"));
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, "build/out.js"), "x\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists tracked edits, staged or not, and untracked files — sorted, without deletions, ignored or unchanged files", async () => {
    expect(await listChangedFiles(root, base)).toEqual([
      "src/edited.ts",
      "src/fresh.ts",
      "src/shrunk.ts",
      "src/staged.ts",
    ]);
  });

  it("reads a rewritten line and an appended block as two added ranges", async () => {
    expect(await readAddedLineRanges(root, base, "src/edited.ts")).toEqual([
      { start: 3, end: 3 },
      { start: 10, end: 12 },
    ]);
  });

  it("reads no added range for a pure deletion", async () => {
    expect(await readAddedLineRanges(root, base, "src/shrunk.ts")).toEqual([]);
  });

  it("reads a staged edit's added line", async () => {
    expect(await readAddedLineRanges(root, base, "src/staged.ts")).toEqual([{ start: 3, end: 3 }]);
  });

  it("reads an untracked file as one range covering the whole file", async () => {
    expect(await readAddedLineRanges(root, base, "src/fresh.ts")).toEqual([{ start: 1, end: 4 }]);
  });

  it("reads no added range for an unchanged file", async () => {
    expect(await readAddedLineRanges(root, base, "src/untouched.ts")).toEqual([]);
  });
});

/**
 * The same reads for many files at once (bd tea-rags-mcp-fdef2): one `git diff
 * -U0` over every path plus one untracked listing, parsed per file — a review of
 * 200 changed files costs two subprocesses, not 200.
 */
describe("git CLI client — added line ranges of many files in one read", { timeout: 30_000 }, () => {
  let root: string;
  let base: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "changed-lines-bulk-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@x");
    git(root, "config", "user.name", "t");
    mkdirSync(join(root, "src/pages"), { recursive: true });
    writeFileSync(join(root, "src/edited.ts"), numberedLines(9, "line"));
    writeFileSync(join(root, "src/shrunk.ts"), numberedLines(6, "line"));
    writeFileSync(join(root, "src/untouched.ts"), numberedLines(3, "line"));
    writeFileSync(join(root, "src/old-name.ts"), numberedLines(3, "moved"));
    writeFileSync(join(root, "src/pages/[id].ts"), numberedLines(2, "page"));
    writeFileSync(join(root, "src/with space.ts"), numberedLines(2, "spaced"));
    writeFileSync(join(root, 'src/quo"té.ts'), numberedLines(2, "quoted"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    base = git(root, "rev-parse", "HEAD").trim();

    const edited = numberedLines(9, "line").split("\n");
    edited[2] = "rewritten 3";
    writeFileSync(join(root, "src/edited.ts"), `${edited.slice(0, 9).join("\n")}\n${numberedLines(3, "appended")}`);
    const shrunk = numberedLines(6, "line").split("\n");
    writeFileSync(join(root, "src/shrunk.ts"), `${[shrunk[0], ...shrunk.slice(3, 6)].join("\n")}\n`);
    // A staged rename reads, with --no-renames, as its new side added whole.
    git(root, "mv", "src/old-name.ts", "src/new-name.ts");
    // Glob characters and a space are literal path characters, not a pathspec.
    writeFileSync(join(root, "src/pages/[id].ts"), `${numberedLines(2, "page")}added 3\n`);
    writeFileSync(join(root, "src/with space.ts"), `${numberedLines(2, "spaced")}added 3\n`);
    // A quote forces git's C-quoting even under core.quotePath=false; the é rides along as octal bytes.
    writeFileSync(join(root, 'src/quo"té.ts'), `added 1\n${numberedLines(2, "quoted")}`);
    writeFileSync(join(root, "src/fresh.ts"), numberedLines(4, "fresh"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("answers every asked path from one read: edits, deletions, renames, untracked, literal paths", async () => {
    const ranges = await readAddedLineRangesOfFiles(root, base, [
      "src/edited.ts",
      "src/shrunk.ts",
      "src/untouched.ts",
      "src/new-name.ts",
      "src/fresh.ts",
      "src/pages/[id].ts",
      "src/with space.ts",
      'src/quo"té.ts',
    ]);
    expect(Object.fromEntries(ranges)).toEqual({
      'src/quo"té.ts': [{ start: 1, end: 1 }],
      "src/edited.ts": [
        { start: 3, end: 3 },
        { start: 10, end: 12 },
      ],
      "src/shrunk.ts": [],
      "src/untouched.ts": [],
      "src/new-name.ts": [{ start: 1, end: 3 }],
      "src/fresh.ts": [{ start: 1, end: 4 }],
      "src/pages/[id].ts": [{ start: 3, end: 3 }],
      "src/with space.ts": [{ start: 3, end: 3 }],
    });
  });

  it("agrees with the per-file read on every path", async () => {
    const paths = ["src/edited.ts", "src/shrunk.ts", "src/new-name.ts", "src/fresh.ts"];
    const bulk = await readAddedLineRangesOfFiles(root, base, paths);
    for (const path of paths) expect(bulk.get(path), path).toEqual(await readAddedLineRanges(root, base, path));
  });

  it("reads nothing for no paths", async () => {
    expect((await readAddedLineRangesOfFiles(root, base, [])).size).toBe(0);
  });
});

// bd tea-rags-mcp-y33ee: a reviewer's `base: "origin/master"` means where the branch left it, not its tip.
describe("git CLI client — merge-base of a review base", { timeout: 30_000 }, () => {
  let root: string;
  let forkPoint: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-base-"));
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "a.ts"), "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    forkPoint = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-q", "-b", "feat");
    writeFileSync(join(root, "b.ts"), "b\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "feat");
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "c.ts"), "c\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "main moves on");
    git(root, "checkout", "-q", "feat");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a base that moved on to the commit HEAD branched from", async () => {
    expect(await readMergeBase(root, "main")).toBe(forkPoint);
  });

  it("resolves HEAD to HEAD's own commit", async () => {
    expect(await readMergeBase(root, "HEAD")).toBe(git(root, "rev-parse", "HEAD").trim());
  });

  it("is null for a commit HEAD shares no history with", async () => {
    const emptyTree = git(root, "hash-object", "-t", "tree", "/dev/null").trim();
    const orphan = git(root, "commit-tree", emptyTree, "-m", "orphan").trim();
    expect(await readMergeBase(root, orphan)).toBeNull();
  });

  it("rejects a ref git does not know", async () => {
    await expect(readMergeBase(root, "no-such-branch")).rejects.toThrow();
  });
});
