import os from "node:os";

/**
 * Default size of the FILE-phase blame worker pool (bd tea-rags-mcp-dog1v).
 * The CPU-parallelism axis: es-git in-process blame is CPU-bound sync work, so
 * the pool caps at 4 to bound worker memory (each worker holds its own libgit2
 * repo handle), floor 1. Lives here — NOT in ingest/pool-defaults.ts — because
 * `domains/trajectory` may not import `domains/ingest` (domain-boundaries).
 * Overridable via `TRAJECTORY_GIT_BLAME_POOL_SIZE` (wired by the config schema).
 */
export function defaultBlamePoolSize(): number {
  return Math.max(1, Math.min(4, os.cpus().length - 1));
}
