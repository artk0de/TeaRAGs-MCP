import os from "node:os";

/**
 * Default size of the FILE-phase blame worker pool = the git-blame CONCURRENCY
 * (bd tea-rags-mcp-dog1v). Blame is native `git blame` (async child process);
 * each pool worker runs one at a time, so N workers = N concurrent `git blame`.
 * Parallel git blame sustains ~69-89 blames/s (6-12 way, EDR does NOT cap
 * aggregate — measured 2026-07-06), so default to 10 (capped at cpus-1). Blame
 * workers are I/O-bound (awaiting the child process), so they do not saturate
 * cores. Lives here — NOT in ingest/pool-defaults.ts — because
 * `domains/trajectory` may not import `domains/ingest` (domain-boundaries).
 * Overridable via `TRAJECTORY_GIT_BLAME_POOL_SIZE` (wired by the config schema).
 */
export function defaultBlamePoolSize(): number {
  return Math.max(1, Math.min(10, os.cpus().length - 1));
}
