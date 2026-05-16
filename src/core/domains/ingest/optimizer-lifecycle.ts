/**
 * OptimizerLifecycle — pauses the Qdrant optimizer for the duration of a
 * function, then resumes it in a `finally` block.
 *
 * Resume runs even when the wrapped function throws — the next reindex's
 * pause/resume pair is idempotent and heals state on failure.
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { isDebug } from "./pipeline/infra/runtime.js";

export class OptimizerLifecycle {
  constructor(private readonly qdrant: QdrantManager) {}

  async with<T>(collection: string, fn: () => Promise<T>): Promise<T> {
    await this.qdrant.pauseOptimizer(collection);
    try {
      return await fn();
    } finally {
      // Revert thresholds: triggers one optimizer pass over freshly-indexed
      // points. Non-fatal on failure — next run's pause/resume heals it.
      await this.qdrant.resumeOptimizer(collection).catch((err) => {
        /* v8 ignore next 3 -- debug logging for non-fatal resume failure */
        if (isDebug()) {
          console.error(`[OptimizerLifecycle] resumeOptimizer failed (next reindex will heal):`, err);
        }
      });
    }
  }
}
