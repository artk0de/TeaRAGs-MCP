import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  globalGitIgnorePath,
  repoInfoExcludePath,
} from "../../../../../src/core/domains/ingest/pipeline/git-excludes.js";

describe("git exclude paths", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("uses core.excludesfile when git configured one", () => {
    expect(globalGitIgnorePath({}, "/home/dev", "~/dotfiles/ignore")).toBe("/home/dev/dotfiles/ignore");
    expect(globalGitIgnorePath({}, "/home/dev", "/etc/git-ignore")).toBe("/etc/git-ignore");
  });

  it("falls back to the XDG git ignore file", () => {
    expect(globalGitIgnorePath({ XDG_CONFIG_HOME: "/xdg" }, "/home/dev", null)).toBe("/xdg/git/ignore");
    expect(globalGitIgnorePath({}, "/home/dev", null)).toBe("/home/dev/.config/git/ignore");
  });

  it("reads info/exclude from a linked worktree's common git dir", async () => {
    const main = mkdtempSync(join(tmpdir(), "git-exclude-main-"));
    const wt = mkdtempSync(join(tmpdir(), "git-exclude-wt-"));
    dirs.push(main, wt);
    const gitDir = join(main, ".git", "worktrees", "feature");
    mkdirSync(join(main, ".git", "info"), { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(main, ".git", "info", "exclude"), "external-worktrees/\n");
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    writeFileSync(join(wt, ".git"), `gitdir: ${gitDir}\n`);

    expect(await repoInfoExcludePath(wt)).toBe(join(main, ".git", "info", "exclude"));
  });
});
