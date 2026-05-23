/**
 * MissedFileTracker — bookkeeping helper for files whose chunks landed
 * without matching file-level enrichment metadata.
 *
 * Extracted from EnrichmentApplier (M2.C.2) to isolate missed-file
 * accumulation from the happy-path apply flow. Provides:
 *   - missed file count (for marker / health reporting)
 *   - bounded sample of missed paths (for debug visibility)
 *   - per-file chunk references (consumed by EnrichmentBackfiller)
 */

import type { MissedFileChunk } from "./types.js";

export interface MissedFileTrackerOptions {
  /** Maximum number of paths retained in `samples`. Excess paths are still counted. */
  sampleLimit: number;
}

export class MissedFileTracker {
  private _missedCount = 0;
  private readonly _samples: string[] = [];
  private readonly _chunks = new Map<string, MissedFileChunk[]>();

  constructor(private readonly opts: MissedFileTrackerOptions) {}

  /** Record one missed file together with its chunk references. */
  track(relativePath: string, chunks: readonly MissedFileChunk[]): void {
    this._missedCount++;
    if (this._samples.length < this.opts.sampleLimit) {
      this._samples.push(relativePath);
    }
    const existing = this._chunks.get(relativePath) ?? [];
    existing.push(...chunks);
    this._chunks.set(relativePath, existing);
  }

  /**
   * Adjust the missed counter after a successful backfill. Mirrors the
   * legacy semantics on EnrichmentApplier — sample/chunks maps are NOT
   * pruned, only the count moves.
   *
   * Clamped at zero: the backfiller decrements by the count of files it
   * successfully re-enriched, but `_missedCount` is incremented by
   * `applyFileSignals` per BATCH (a single file appearing in two
   * batches with missing-then-arriving file metadata counts twice).
   * Without the clamp, a backfill round produces a negative
   * `missedFiles` reported by `get_index_status` (observed -133 on
   * ugnest, where codegraph and git both backfilled paths the applier
   * tracked once but the providers reported overlay for every file
   * regardless of prior miss). Clamping is the right behavior — a
   * negative `missedFiles` is nonsense and downstream consumers
   * (health-mapper, marker-store) would propagate it into MCP output.
   */
  decrementMissed(count: number): void {
    this._missedCount = Math.max(0, this._missedCount - count);
  }

  get missedCount(): number {
    return this._missedCount;
  }

  get samples(): readonly string[] {
    return this._samples;
  }

  /** Read-only snapshot of all missed files and their chunk references. */
  get chunkMap(): ReadonlyMap<string, readonly MissedFileChunk[]> {
    return this._chunks;
  }

  chunksFor(path: string): readonly MissedFileChunk[] {
    return this._chunks.get(path) ?? [];
  }
}
