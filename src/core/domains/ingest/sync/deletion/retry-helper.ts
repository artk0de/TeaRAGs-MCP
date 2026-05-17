/**
 * DeletionRetryHelper — per-id retry + outcome accumulation.
 *
 * Extracted from `performDeletion`'s L2 fallback branch. Owns the contract:
 * given a list of ids and a per-id-batch attempt fn, retry each id up to
 * `maxRetries` times (with `backoffMs` between attempts) and accumulate
 * succeeded/failed sets.
 *
 * Stateless across executions — safe to reuse. Caller passes the attempt
 * boundary (a BatchDeleteExecutor.deleteBatch in production); helper stays
 * free of Qdrant types.
 *
 * Used by: src/core/domains/ingest/sync/deletion/strategy.ts (L2 fallback).
 */

import { createDeletionOutcome, type DeletionOutcome } from "./outcome.js";

export interface RetryOptions {
  /** Total attempt budget per id. `1` = no retry (single shot). MUST be ≥ 1. */
  maxRetries: number;
  /** Sleep between retries in ms. Ignored when `maxRetries === 1`. */
  backoffMs: number;
}

/**
 * Attempt callback. Receives a single-id batch (helper drives per-id).
 * Throw on failure — helper handles retry policy. Resolve on success.
 */
export type AttemptFn = (ids: string[]) => Promise<void>;

export class DeletionRetryHelper {
  constructor(private readonly opts: RetryOptions) {}

  /**
   * Runs `attempt` for every id with the configured retry policy.
   * Returns a DeletionOutcome where each id lives in exactly one of
   * `succeeded` / `failed`. Does NOT populate `chunksDeleted` — caller
   * owns that (it derives from collection point counts, not per-id).
   */
  async execute(ids: string[], attempt: AttemptFn): Promise<DeletionOutcome> {
    const outcome = createDeletionOutcome(ids);
    if (ids.length === 0) return outcome;

    const budget = Math.max(1, this.opts.maxRetries);

    for (const id of ids) {
      let succeeded = false;
      let lastError: unknown;
      for (let attemptIdx = 0; attemptIdx < budget; attemptIdx++) {
        try {
          await attempt([id]);
          succeeded = true;
          break;
        } catch (error) {
          lastError = error;
          if (attemptIdx < budget - 1 && this.opts.backoffMs > 0) {
            await sleep(this.opts.backoffMs);
          }
        }
      }
      if (!succeeded) {
        outcome.markFailed(id);
        // lastError intentionally swallowed: caller observes via outcome.failed
        // and downstream logging in strategy.ts. Re-throwing here
        // would defeat the partial-outcome contract.
        void lastError;
      }
    }

    return outcome;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
