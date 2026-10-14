/**
 * The repository's remote URLs (bd tea-rags-mcp-8rcox): whether `#N` in a
 * commit message names a forge issue depends on the remote the repository
 * pushes to, so the git trajectory reads them through the adapter.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

describe("GitCliAdapter#readRemoteUrls", { timeout: 30_000 }, () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "remote-urls-"));
    git(root, "init", "-q");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists every configured remote's URL in config order", async () => {
    git(root, "remote", "add", "origin", "git@github.com:org/repo.git");
    git(root, "remote", "add", "mirror", "https://gitlab.example.dev/org/repo.git");

    expect(await new GitCliAdapter(root).readRemoteUrls()).toEqual([
      "git@github.com:org/repo.git",
      "https://gitlab.example.dev/org/repo.git",
    ]);
  });

  it("answers no URLs for a repository without a remote", async () => {
    expect(await new GitCliAdapter(root).readRemoteUrls()).toEqual([]);
  });
});
