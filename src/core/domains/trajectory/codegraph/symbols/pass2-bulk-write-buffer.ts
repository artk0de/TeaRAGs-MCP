/**
 * Pass-2's buffered, double-buffered bulk write (bd tea-rags-mcp-6aytq),
 * lifted out of `GraphBuildFinalizer#resolveAndUpsert` as its own unit (bd
 * tea-rags-mcp-89k7k.35.17). One instance lives for one pass.
 *
 * It owns three pieces of state that only make sense together: the files
 * buffered for the next bulk transaction, the relPaths among them, and the ONE
 * write allowed to be open while the loop keeps resolving.
 */

import type { BulkFileUpsertEntry, GraphDbClient } from "../../../../contracts/types/codegraph.js";
import { CodegraphResolveError } from "../../errors.js";
import type { CodegraphPhaseTimings } from "./phase-timings.js";

export class Pass2BulkWriteBuffer {
  private entries: BulkFileUpsertEntry[] = [];
  /**
   * Which relPaths already have a pending entry — a file can legitimately reach
   * the spill twice (re-walking mid-run is a supported, tested scenario;
   * symbolTable.upsertFile replaces rather than appends for exactly this
   * reason). The caller dispatches before buffering a repeat, so the repeat
   * gets its own transaction rather than sharing one with its earlier self, and
   * the batch's LAST edge set for a relPath is unambiguously the one persisted
   * — `writeFileRowsBulk` would otherwise collapse the pair silently
   * (tea-rags-mcp-ksfq1: the collapse used to abort the daemon with a native
   * FatalException; tea-rags-mcp-8l8d3 removed that failure mode at the
   * writer, which leaves this guard as the ordering statement it always was).
   * Cleared on every dispatch alongside the entries it tracks.
   */
  private bufferedRelPaths = new Set<string>();
  /**
   * The ONE bulk write allowed to be open while the loop keeps resolving.
   * Measured on taxdome: the flush was awaited inline, costing 44.0s over 42
   * calls — ~1s of dead wall clock per BULK_FILES window while the daemon
   * committed and the resolver idled. Double-buffering hides that behind the
   * next window's resolve work.
   *
   * Strictly one in flight, never two: {@link dispatch} settles the previous
   * write before opening the next, so the daemon session still sees a single
   * serialized stream of bulk transactions in submission order — the
   * DELETE+INSERT interleave inside `upsertFilesBulk` stays untouched, and so
   * does the (source, target) primary-key invariant that `bufferedRelPaths`
   * guards. At most two batches are alive: the one being written and the one
   * being filled.
   */
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly graphDb: GraphDbClient,
    private readonly timings: CodegraphPhaseTimings,
  ) {}

  /** Files buffered for the next bulk transaction. */
  get size(): number {
    return this.entries.length;
  }

  /** True when `relPath` already has an entry pending in this batch. */
  holds(relPath: string): boolean {
    return this.bufferedRelPaths.has(relPath);
  }

  add(entry: BulkFileUpsertEntry): void {
    this.entries.push(entry);
    this.bufferedRelPaths.add(entry.node.relPath);
  }

  /**
   * Hand the buffered files to the session as ONE transaction without waiting
   * for it to land. `processed` is the loop's file counter at dispatch time,
   * carried into the error a failed write raises.
   */
  async dispatch(processed: number): Promise<void> {
    if (this.entries.length === 0) return;
    const pending = this.entries;
    this.entries = [];
    this.bufferedRelPaths = new Set();
    // Ordering point: the previous batch must have landed before this one is
    // handed to the session.
    await this.settle();
    const started = this.write(pending, processed);
    // The rejection is consumed by `settle`; attach a no-op handler so the
    // window between dispatch and settle cannot raise an unhandled rejection
    // and kill the process.
    void started.catch(() => undefined);
    this.inFlight = started;
  }

  /**
   * Await the open write, and charge the loop ONLY for what it actually waited
   * on. `flush` telemetry used to span the whole write; now the overlapped
   * portion is invisible to it by design — the gap between the ms recorded
   * here and the write's real duration IS the saving.
   *
   * Measured on the accumulator's own clock rather than `Date.now`, so the
   * duration and the `elapsedMs` it is compared against always come from one
   * clock — and so a test can inject a manual one and assert the awaited
   * portion exactly instead of sampling wall clock (bd tea-rags-mcp-lffhl).
   */
  async settle(): Promise<void> {
    const open = this.inFlight;
    if (!open) return;
    this.inFlight = null;
    const startedAtMs = this.timings.nowMs();
    try {
      await open;
    } finally {
      this.timings.record("flush", this.timings.nowMs() - startedAtMs);
    }
  }

  /**
   * Write one batch. The per-file edge cap already dropped pathological files,
   * so no single row can abort a batch. A batch-level failure surfaces batch
   * size + last file so the marker / stderr still points near where pass-2
   * tripped.
   *
   * Deliberately NOT timed here: {@link dispatch} does not await it and
   * {@link settle} records the `flush` phase at the point the loop actually
   * blocks. Timing it here would report the write's full duration and hide
   * exactly the overlap double-buffering exists to create.
   */
  private async write(pending: BulkFileUpsertEntry[], processed: number): Promise<void> {
    try {
      await this.graphDb.upsertFilesBulk(pending);
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      throw new CodegraphResolveError(
        processed,
        Object.assign(wrapped, {
          message: `graphDb.upsertFilesBulk failed near file #${processed} (batch=${pending.length}, last=${pending[pending.length - 1]?.node.relPath}): ${wrapped.message}`,
        }),
      );
    }
  }
}
