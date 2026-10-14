/**
 * The Go module map's `go.mod` read (bd tea-rags-mcp-uqkn5): the same work-tree
 * listing and the same nested-checkout veto as the dependency reads, so a nested
 * `.claude/worktrees/*` checkout's module path never enters the module map.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readManifestFiles } from "../../../../src/core/adapters/filesystem/dependency-manifests.js";

const isGoMod = (name: string): boolean => name === "go.mod";

let root: string;

function write(base: string, relPath: string, body: string): void {
  const abs = join(base, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

/** A nested checkout the way `git worktree add` leaves one: a `.git` FILE naming the main store. */
function writeNestedCheckout(base: string, relDir: string): void {
  write(base, join(relDir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  write(base, join(relDir, "go.mod"), "module example.com/nested\n");
}

function relDirs(at: string = root, extraIgnored?: ReadonlySet<string>): string[] {
  return readManifestFiles(at, isGoMod, extraIgnored)
    .map((file) => file.relDir)
    .sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tea-rags-gomod-"));
  git("init", "-q");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readManifestFiles in a git work tree", () => {
  it("reads a tracked go.mod and an untracked one alike", () => {
    write(root, "go.mod", "module example.com/app\n");
    git("add", "go.mod");
    write(root, "tools/go.mod", "module example.com/app/tools\n");
    expect(relDirs()).toEqual(["", "tools"]);
  });

  it("does not read a nested checkout's go.mod", () => {
    write(root, "go.mod", "module example.com/app\n");
    writeNestedCheckout(root, join(".claude", "worktrees", "x"));
    expect(relDirs()).toEqual([""]);
  });

  it("does not read a go.mod the tree ignores", () => {
    write(root, "go.mod", "module example.com/app\n");
    write(root, ".gitignore", "scratch/\n");
    write(root, "scratch/go.mod", "module example.com/scratch\n");
    expect(relDirs()).toEqual([""]);
  });

  it("still honours the caller's own ignored directories over the listing", () => {
    write(root, "go.mod", "module example.com/app\n");
    write(root, "vendor/dep/go.mod", "module example.com/dep\n");
    git("add", "-A");
    expect(relDirs(root, new Set(["vendor"]))).toEqual([""]);
  });
});

describe("readManifestFiles without a git work tree", () => {
  it("walks, and still skips a directory that is itself a checkout", () => {
    const plain = mkdtempSync(join(tmpdir(), "tea-rags-gomod-nogit-"));
    try {
      write(plain, "go.mod", "module example.com/app\n");
      writeNestedCheckout(plain, join(".claude", "worktrees", "x"));
      expect(relDirs(plain)).toEqual([""]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
