/**
 * Durable batched `cg_symbols` node-write chain (bd tea-rags-mcp-6vfrj / G2,
 * originally Task 2 of the cross-pass eager-flush work).
 *
 * Hoists the durable node write out of the post-embedding finalize tail:
 *
 *   - Both entry points — `acceptExtraction` (cross-pass main-thread tee) and
 *     the extraction sink's `write` (incremental worker) — call {@link
 *     SymbolNodeFlushQueue.buffer}, which appends one file's
 *     `BulkSymbolUpsertEntry` to the per-collection buffer and chains a flush
 *     once the buffer reaches the cadence. Fire-and-chain, NOT awaited in the
 *     hot path.
 *   - Each chain link ends in a `.catch` that LATCHES the first failure and
 *     RESOLVES the link, so the fire-and-chain tail never rejects unhandled
 *     (Node >=22 terminates the process on an unhandled rejection — there is no
 *     `unhandledRejection` handler in this codebase).
 *   - {@link SymbolNodeFlushQueue.flushRemainder} final-flushes the remainder,
 *     awaits the whole chain, and rethrows the latched error — aborting the run
 *     cleanly before pass-2 (nodes-before-edges) without the
 *     unhandled-rejection crash window.
 *
 * Order-independent: `upsertSymbolsBulk` is last-wins per relPath, so the
 * accept-order eager flush yields the same `cg_symbols` the sorted drain would.
 * The chain is single-valued (not per-collection), matching the run-global maps
 * — the provider processes one collection per instance at a time.
 */

import type { BulkSymbolUpsertEntry, GraphDbClient, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import { isDebug } from "../../../../infra/runtime.js";

/**
 * Resolve the graph client for a collection. The queue never learns about pool
 * vs direct routing — the provider passes its own store resolver in.
 */
export type GraphDbResolver = (collectionName?: string) => Promise<{ graphDb: GraphDbClient }>;

export class SymbolNodeFlushQueue {
  private readonly pending = new Map<string, BulkSymbolUpsertEntry[]>();
  private readonly flushedFiles = new Map<string, Set<string>>();
  private chain: Promise<void> = Promise.resolve();
  /**
   * First eager-flush error, latched. Rethrown by {@link flushRemainder} after
   * it awaits the chain, so a mid-embedding flush failure still aborts the run
   * cleanly at the drain. Reset alongside the buffer.
   */
  private latchedError: Error | undefined = undefined;

  constructor(
    private readonly resolveStore: GraphDbResolver,
    private readonly flushFiles: number,
  ) {}

  /**
   * Buffer one file's durable symbol defs — the single seam BOTH entry points
   * share. Appends to the per-collection buffer and enqueues a flush at the
   * cadence. Order-independent: `upsertSymbolsBulk` is last-wins per relPath.
   */
  buffer(
    relPath: BulkSymbolUpsertEntry["relPath"],
    defs: SymbolDefinition[],
    key: string,
    collectionName?: string,
  ): void {
    const buf = this.pending.get(key) ?? [];
    buf.push({ relPath, definitions: defs });
    this.pending.set(key, buf);
    if (buf.length >= this.flushFiles) this.chainFlush(buf.splice(0, buf.length), key, collectionName);
  }

  /**
   * Fire-and-chain flush of whatever is buffered for this collection, WITHOUT
   * awaiting. Used per streamed batch so each batch's `cg_symbols` land durably
   * during embedding overlap: the cadence threshold alone would defer a
   * sub-threshold changeset (the common incremental case) to the finalize
   * remainder, losing the overlap the former per-file `upsertSymbols` had.
   */
  flushPending(key: string, collectionName?: string): void {
    const batch = this.pending.get(key)?.splice(0) ?? [];
    if (batch.length > 0) this.chainFlush(batch, key, collectionName);
  }

  /**
   * Flush the per-collection remainder, await the whole flush chain, and rethrow
   * any latched eager-flush error — aborting the run before pass-2. Every chain
   * link resolves (errors latch rather than reject the tail), so this await
   * never trips an unhandled rejection. Shared by the cross-pass drain and the
   * incremental finalize so `cg_symbols` is fully durable before pass-2 edge
   * resolve (nodes-before-edges).
   */
  async flushRemainder(key: string, collectionName?: string): Promise<void> {
    const remainder = this.pending.get(key)?.splice(0) ?? [];
    if (remainder.length > 0) this.chainFlush(remainder, key, collectionName);
    await this.chain;
    if (this.latchedError) throw this.latchedError;
  }

  /**
   * Reset the flush state at a run-reset seam. With a `key`, drops that
   * collection's buffer + flushed-set entry; without one, clears both maps (full
   * release). Always resets the chain to a resolved promise so a rejected chain
   * from an aborted run never leaks into the next run's `await`.
   */
  reset(key?: string): void {
    if (key === undefined) {
      this.pending.clear();
      this.flushedFiles.clear();
    } else {
      this.pending.delete(key);
      this.flushedFiles.delete(key);
    }
    this.chain = Promise.resolve();
    this.latchedError = undefined;
  }

  /**
   * Append a batched flush to the chain, terminating the link in a `.catch` that
   * LATCHES the first error and RESOLVES the link. Keeping every link resolved is
   * load-bearing: a bare rejected tail would be unhandled during the
   * accept→drain window and, on Node >=22 with no `unhandledRejection` handler,
   * terminate the indexer process.
   */
  private chainFlush(batch: BulkSymbolUpsertEntry[], key: string, collectionName?: string): void {
    this.chain = this.chain
      .then(async () => this.flushBatch(batch, key, collectionName))
      .catch((e: unknown) => {
        this.latchedError ??= e instanceof Error ? e : new Error(String(e));
      });
  }

  /**
   * One durable batched node write: `graphDb.upsertSymbolsBulk(batch)` (one
   * transaction, DELETE-per-file + INSERT OR IGNORE, last-wins per relPath).
   * Records the flushed relPaths per collection (once-per-file invariant +
   * honest cumulative count) and emits a DEBUG-gated flush log.
   */
  private async flushBatch(batch: BulkSymbolUpsertEntry[], key: string, collectionName?: string): Promise<void> {
    if (batch.length === 0) return;
    const { graphDb } = await this.resolveStore(collectionName);
    await graphDb.upsertSymbolsBulk(batch);
    const flushed = this.flushedFiles.get(key) ?? new Set<string>();
    for (const e of batch) flushed.add(e.relPath);
    this.flushedFiles.set(key, flushed);
    if (isDebug()) {
      console.error("[GitEnrich] PHASE: CODEGRAPH_NODES_FLUSH", { batch: batch.length, cumulative: flushed.size });
    }
  }
}
