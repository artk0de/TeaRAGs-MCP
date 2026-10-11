/**
 * Waiting for a collection's queued writes to apply, as a bounded loop over
 * Qdrant's `wait_timeout` answer (bd tea-rags-mcp-yf4je, tea-rags-mcp-wjyaf).
 *
 * Qdrant 1.18 ends a `wait: true` request after its own ~60 s with a SUCCESSFUL
 * response whose status is `wait_timeout`: the update is queued, not applied.
 * Every waited write that must be visible to the next read — a marker, a
 * backfill page, a field index — reads that status through this one loop
 * instead of growing its own. The caller owns what an exhausted budget means.
 */

import type { QdrantUpdateStatus } from "./types.js";

/**
 * What waiting for a collection's queued writes established.
 *
 * - `drained` — Qdrant confirmed (`completed`) the queue applied.
 * - `timedOut` — every round answered `wait_timeout` until the budget was
 *   spent: the queue is still undrained, and a read now sees stale segments.
 * - `failed` — the barrier request itself threw; best-effort.
 */
export type PayloadWriteBarrierOutcome =
  | { readonly kind: "drained"; readonly rounds: number; readonly waitedMs: number }
  | { readonly kind: "timedOut"; readonly rounds: number; readonly waitedMs: number }
  | { readonly kind: "failed" };

/**
 * The status of one Qdrant update answer — a `batchUpdate` result list is
 * folded over its per-operation results (`wait_timeout` if any operation's wait
 * ran out, else `acknowledged` if any is only queued, else `completed`); a
 * single-operation answer carries its own status. An answer stating no status
 * reads as `completed`: nothing in it says the update is still queued.
 */
export function foldUpdateStatus(answer: unknown): QdrantUpdateStatus {
  const results = Array.isArray(answer) ? answer : [answer];
  const statuses = results.map((result: unknown) => (result as { status?: unknown } | null | undefined)?.status);
  if (statuses.includes("wait_timeout")) return "wait_timeout";
  if (statuses.includes("acknowledged")) return "acknowledged";
  return "completed";
}

/** The one client operation the loop needs; `QdrantManager` provides it. */
export interface WriteBarrierClient {
  awaitQueuedUpdates: (collection: string) => Promise<QdrantUpdateStatus>;
}

/** Where the loop reports; each caller maps these onto its own log channel. */
export interface WriteBarrierLog {
  timedOutRound: (fields: {
    collection: string;
    round: number;
    roundMs: number;
    waitedMs: number;
    budgetMs: number;
  }) => void;
  failed: (fields: { collection: string; error: string }) => void;
}

export interface WriteBarrierOptions {
  /** Total time the loop may spend repeating timed-out rounds. */
  readonly budgetMs: number;
  /** Clock in epoch ms; injectable so a spent budget needs no real wait. */
  readonly now?: () => number;
  readonly log: WriteBarrierLog;
}

/**
 * Repeat the queued-updates barrier until Qdrant answers anything but
 * `wait_timeout`, while the time spent stays under `budgetMs`. Never throws: a
 * thrown barrier is `failed`, leaving the caller reading whatever is applied.
 */
export async function awaitWriteBarrier(
  client: WriteBarrierClient,
  collection: string,
  options: WriteBarrierOptions,
): Promise<PayloadWriteBarrierOutcome> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let rounds = 0;
  try {
    for (;;) {
      const roundStartedAt = now();
      const status = await client.awaitQueuedUpdates(collection);
      rounds++;
      const waitedMs = now() - startedAt;
      if (status !== "wait_timeout") return { kind: "drained", rounds, waitedMs };
      options.log.timedOutRound({
        collection,
        round: rounds,
        roundMs: now() - roundStartedAt,
        waitedMs,
        budgetMs: options.budgetMs,
      });
      if (waitedMs >= options.budgetMs) return { kind: "timedOut", rounds, waitedMs };
    }
  } catch (error) {
    options.log.failed({ collection, error: error instanceof Error ? error.message : String(error) });
    return { kind: "failed" };
  }
}
