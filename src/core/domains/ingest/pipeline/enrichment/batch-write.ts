/**
 * batchSetPayloadWithRetry — bounded retry around qdrant.batchSetPayload for
 * enrichment writes.
 *
 * Enrichment payload writes (file/chunk signal applies, backfill) used to wrap
 * batchSetPayload in a swallow-only try/catch: a single transient Qdrant blip
 * (timeout / 429 mid-stream) silently dropped a whole batch of ~100 chunks'
 * signals, leaving them without `enrichedAt` -> permanent degraded until the
 * next reindex (observed: ~150 unenriched on a full taxdome run).
 *
 * This helper retries the write with exponential backoff. It returns a boolean
 * rather than rethrowing so callers can route the residual (chunks whose write
 * never landed) into the missed-file backfill loop instead of losing them.
 *
 * Returns `true` when the write landed (possibly after retries), `false` when
 * the attempt budget is exhausted.
 */

import { isDebug } from "../infra/runtime.js";

export interface BatchPayloadOp {
  payload: Record<string, unknown>;
  points: (string | number)[];
  key?: string;
}

export interface BatchWriteRetryOptions {
  /** Total attempt budget (first try + retries). MUST be ≥ 1. Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms; doubled each retry. Default 100. Ignored at 0. */
  baseDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;

export async function batchSetPayloadWithRetry(
  qdrant: { batchSetPayload: (collectionName: string, operations: BatchPayloadOp[]) => Promise<void> },
  collectionName: string,
  operations: BatchPayloadOp[],
  opts: BatchWriteRetryOptions = {},
): Promise<boolean> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await qdrant.batchSetPayload(collectionName, operations);
      return true;
    } catch (error) {
      const isLast = attempt === maxAttempts - 1;
      if (isLast) {
        if (isDebug()) {
          console.error(`[Enrichment] batchSetPayload failed after ${maxAttempts} attempts:`, error);
        }
        return false;
      }
      if (baseDelayMs > 0) {
        await sleep(baseDelayMs * 2 ** attempt);
      }
    }
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
