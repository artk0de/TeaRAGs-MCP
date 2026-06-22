import os from "node:os";

/** Parallel chunker default now that workers are process-isolated (cap 4 to bound memory). */
export function defaultChunkerPoolSize(): number {
  return Math.max(1, Math.min(4, os.cpus().length - 1));
}
