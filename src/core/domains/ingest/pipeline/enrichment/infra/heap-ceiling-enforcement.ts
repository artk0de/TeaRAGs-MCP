/**
 * Is the enrichment worker's declared heap ceiling actually being ENFORCED?
 * (bd tea-rags-mcp-6aytq)
 *
 * `ENRICHMENT_WORKER_MEMORY_LIMIT_MB` reaches a worker thread as
 * `resourceLimits.maxOldGenerationSizeMb` (`../../infra/thread-transport.ts`),
 * and with the enrichment pool's liveness timeout disabled it is the ONLY bound
 * standing between a runaway provider and the machine's memory. That bound has a
 * silent failure mode: a process-wide `NODE_OPTIONS=--max_old_space_size=...`
 * takes precedence over per-worker `resourceLimits`, so the ceiling is declared,
 * accepted, reported nowhere, and enforces nothing.
 *
 * Probed on the dev machine (fish universal `NODE_OPTIONS=--max_old_space_size=8192`):
 * a thread declaring 128 MB reported `heap_size_limit` 8384 MB and never raised
 * `ERR_WORKER_OUT_OF_MEMORY`. With the variable stripped, the same mechanism
 * behaved exactly as documented — declared 2048, actual 2240.
 *
 * That 2240-for-2048 is the reason this is a TOLERANCE and not an equality
 * check: V8 sizes the old generation in its own increments and lands slightly
 * above what was asked for. The question worth answering is not "did V8 round
 * up" but "is the number in force anything like the number requested".
 *
 * Pure by design — the boot path (`./worker.ts`) supplies both readings and owns
 * the emit, so the comparison is unit-testable without spawning a thread. It
 * OBSERVES: it never throws and never changes what the worker does. A host where
 * the ceiling is inert is not misconfigured, it is merely not protected, and the
 * only useful thing to do about that is say so once.
 */

/**
 * Actual-over-declared ratio above which the ceiling is treated as not in force.
 *
 * Wide enough to swallow V8's own rounding (measured 2240/2048 = 1.09), narrow
 * enough that a process-wide override cannot hide behind it — an override is a
 * whole different order of magnitude (8384/2048 = 4.1), never a few percent.
 */
export const HEAP_CEILING_ENFORCEMENT_TOLERANCE = 1.25;

const BYTES_PER_MB = 1024 * 1024;

export interface HeapCeilingObservation {
  /**
   * `worker_threads.resourceLimits.maxOldGenerationSizeMb` as read INSIDE the
   * thread. Absent (or `0`) means no ceiling was asked for, which is a
   * configuration, not a discrepancy.
   */
  readonly declaredMaxOldGenerationSizeMb?: number;
  /** `v8.getHeapStatistics().heap_size_limit`, in bytes — what is in force. */
  readonly heapSizeLimitBytes?: number;
}

function isUsable(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * One line describing an inert heap ceiling, or `undefined` when there is
 * nothing to report — no ceiling declared, no usable reading, or the two agree
 * within `HEAP_CEILING_ENFORCEMENT_TOLERANCE`. Silence is the expected outcome.
 */
export function describeUnenforcedHeapCeiling(observation: HeapCeilingObservation): string | undefined {
  const { declaredMaxOldGenerationSizeMb: declaredMb, heapSizeLimitBytes } = observation;
  if (!isUsable(declaredMb) || !isUsable(heapSizeLimitBytes)) return undefined;

  const actualMb = Math.round(heapSizeLimitBytes / BYTES_PER_MB);
  if (actualMb <= declaredMb * HEAP_CEILING_ENFORCEMENT_TOLERANCE) return undefined;

  return (
    `heap ceiling NOT in force: declared ${declaredMb} MB, V8 reports ${actualMb} MB. ` +
    `A process-wide NODE_OPTIONS --max_old_space_size overrides worker resourceLimits, ` +
    `so ENRICHMENT_WORKER_MEMORY_LIMIT_MB bounds nothing on this thread.`
  );
}
