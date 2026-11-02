// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Git ignore sources FileScanner used to skip. A repo-root `.gitignore` is not
 * the whole set: `core.excludesfile` (default `~/.config/git/ignore`) and
 * `$GIT_DIR/info/exclude` also hide paths, and git applies them at lower
 * precedence than the project's `.gitignore`.
 */

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** `core.excludesfile` when set, otherwise the XDG default git ignore file. */
export function globalGitIgnorePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  configured?: string | null,
): string {
  const fromConfig = configured?.trim();
  if (fromConfig) {
    const expanded = fromConfig.startsWith("~/") ? join(home, fromConfig.slice(2)) : fromConfig;
    return isAbsolute(expanded) ? expanded : resolve(home, expanded);
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : join(home, ".config");
  return join(base, "git", "ignore");
}

/** `git config --global --get core.excludesfile`, or null when unset or git is missing. */
export function readGlobalExcludesFileSetting(): string | null {
  try {
    const out = execFileSync("git", ["config", "--global", "--get", "core.excludesfile"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * `$GIT_DIR/info/exclude`. A linked worktree's `.git` is a file pointing at
 * `…/.git/worktrees/<name>`; the exclude file lives in the common git dir.
 */
export async function repoInfoExcludePath(rootPath: string): Promise<string | undefined> {
  const gitPath = join(rootPath, ".git");
  try {
    const stat = await fs.stat(gitPath);
    if (stat.isDirectory()) return join(gitPath, "info", "exclude");
    const text = await fs.readFile(gitPath, "utf-8");
    const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
    const gitdir = match?.[1]?.trim();
    if (!gitdir) return undefined;
    const gitDir = resolve(rootPath, gitdir);
    let common = gitDir;
    try {
      const relativeCommon = (await fs.readFile(join(gitDir, "commondir"), "utf-8")).trim();
      if (relativeCommon.length > 0) common = resolve(gitDir, relativeCommon);
    } catch {
      // A plain gitdir with no commondir keeps its own info/exclude.
    }
    return join(common, "info", "exclude");
  } catch {
    return undefined;
  }
}
