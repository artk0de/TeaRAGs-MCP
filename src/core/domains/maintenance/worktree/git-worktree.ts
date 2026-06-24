import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Idempotent: no-op when targetPath already exists (attach to existing worktree).
 * Otherwise: `git -C repoRoot worktree add [-b branch] targetPath`.
 */
export function ensureGitWorktree(repoRoot: string, name: string, targetPath: string, branch?: string): void {
  if (existsSync(targetPath)) return;
  const args = ["-C", repoRoot, "worktree", "add"];
  if (branch) args.push("-b", branch);
  else args.push("-b", name);
  args.push(targetPath);
  execFileSync("git", args, { stdio: "pipe" });
}

/**
 * `git -C repoRoot worktree remove [--force] targetPath`.
 */
export function removeGitWorktree(repoRoot: string, targetPath: string, force: boolean): void {
  const args = ["-C", repoRoot, "worktree", "remove"];
  if (force) args.push("--force");
  args.push(targetPath);
  execFileSync("git", args, { stdio: "pipe" });
}
