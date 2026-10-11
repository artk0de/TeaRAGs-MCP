import os from "node:os";

import { defaultIoBoundPoolSize } from "../../../../../primitives/concurrency/index.js";

/**
 * Default size of the FILE-phase blame worker pool = the git-blame CONCURRENCY
 * (bd tea-rags-mcp-dog1v). Each pool worker runs one native `git blame` (async
 * child process) at a time, so N workers = N concurrent blames — an I/O-bound
 * pool, sized by the shared `defaultIoBoundPoolSize` primitive
 * (bd tea-rags-mcp-k7kmu C10). Lives here — NOT in ingest/pool-defaults.ts —
 * because `domains/trajectory` may not import `domains/ingest`
 * (domain-boundaries). Overridable via `TRAJECTORY_GIT_BLAME_POOL_SIZE`
 * (wired by the config schema).
 */
export function defaultBlamePoolSize(): number {
  return defaultIoBoundPoolSize(os.cpus().length);
}
