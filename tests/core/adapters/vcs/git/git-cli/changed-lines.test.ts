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

import { listChangedFiles, readAddedLineRanges } from "../../../../../../src/core/adapters/vcs/git/git-cli/client.js";

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
