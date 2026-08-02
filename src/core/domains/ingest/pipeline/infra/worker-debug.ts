/**
 * Carries the debug flag across the worker-thread boundary.
 *
 * `isDebug()` reads a module-level flag that `bootstrap/factory.ts` sets once
 * from config — in the MAIN thread. A worker thread loads its own copy of the
 * module registry, so that flag starts false there regardless of how the
 * process was launched. Every debug marker emitted from inside a worker was
 * therefore silently dropped: the codegraph pass-2 phase (resolve, streaming
 * SCC/PageRank, checkpoint cadence) runs in the enrichment pool, so its
 * progress markers never reached a log file and that window stayed unmeasured.
 *
 * The pool ships the flag in `workerData`; the worker entry hands that payload
 * here. Kept as a separate function, not inlined into the entry, so the
 * adoption rule is unit-testable without spawning a thread.
 */
import { setDebug } from "../../../../infra/runtime.js";

/**
 * Adopt `debug` from a worker's init payload. Anything that is not an explicit
 * boolean leaves the flag alone — this runs at worker startup where throwing
 * would take down the thread over a diagnostics-only concern.
 */
export function applyWorkerDebug(workerData: unknown): void {
  if (typeof workerData !== "object" || workerData === null) return;
  const { debug } = workerData as { debug?: unknown };
  if (typeof debug !== "boolean") return;
  setDebug(debug);
}
