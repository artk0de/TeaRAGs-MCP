/**
 * Default size of a worker pool whose jobs are I/O-BOUND — each worker spends
 * its life awaiting an external process or response, so N workers do not
 * saturate N cores and the pool may run up to cpuCount-1 wide (one core stays free for the parent)
 * (bd tea-rags-mcp-k7kmu C10). The ceiling of 10 is measured, not derived:
 * parallel `git blame` sustained ~69-89 blames/s from 6-12 workers with no
 * aggregate cap below that (bd tea-rags-mcp-dog1v, measured 2026-07-06).
 *
 * The cpu count is a PARAMETER: this is a primitives module, and `node:os` is
 * an I/O module the primitives I/O-free guard forbids
 * (`tests/core/primitives/no-io-guard.test.ts`). The domain that owns the
 * pool reads `os.cpus()` and hands the number in.
 */
export function defaultIoBoundPoolSize(cpuCount: number): number {
  return Math.max(1, Math.min(10, cpuCount - 1));
}
