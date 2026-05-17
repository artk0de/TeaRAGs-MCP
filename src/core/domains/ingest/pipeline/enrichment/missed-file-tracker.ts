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
   */
  decrementMissed(count: number): void {
    this._missedCount -= count;
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
