/**
 * Worktree HEAD tripwire (vitest globalSetup).
 *
 * Real-git fixture tests (e.g. tests/core/adapters/git/client-catfile.test.ts)
 * run `git init`/`git commit` in temp dirs. If one ever runs against a broken
 * cwd, it commits onto the REAL worktree's HEAD — silently corrupting the dev
 * repo. This snapshots HEAD before the run and fails the run loudly if any test
 * moved it, so corruption can never pass unnoticed (the per-test `gitIn` guard
 * in client-catfile.test.ts is the first line of defense; this is the backstop).
 *
 * Runs once in the main process (cwd = the worktree root). No-op when git is
 * unavailable (CI image without git, detached env).
 */
import { execFileSync } from "node:child_process";

function head(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export default function setup(): () => void {
  const before = head();
  return () => {
    const after = head();
    if (before && after && before !== after) {
      throw new Error(
        `WORKTREE GIT CORRUPTION: a test moved HEAD ${before} -> ${after}. ` +
          `Some test ran 'git commit' against the real worktree (a real-git fixture ` +
          `with a broken temp cwd). Investigate before trusting this run.`,
      );
    }
  };
}
