/**
 * StatsStoreAdapter — adapts StatsCache + QdrantManager to the StatsStore
 * interface.
 *
 * Measures the collection's similarity scale from the points that are already
 * stored and writes it into the existing stats file. Nothing is re-embedded and
 * nothing is re-chunked, which is what makes this a migration rather than a
 * reindex prompt.
 */

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import { sampleVectors } from "../../../../adapters/qdrant/scroll.js";
import { computeScoreBackground } from "../../../../infra/score-background.js";
import type { StatsCache } from "../../../../infra/stats-cache.js";
import type { StatsStore } from "../types.js";

/** Matches the sample size the indexing path uses, so both paths agree. */
export const SCORE_BACKGROUND_SAMPLE = 1200;

type SampleFn = (qdrant: QdrantManager, collection: string, maxVectors: number) => Promise<number[][]>;

export class StatsStoreAdapter implements StatsStore {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly statsCache: StatsCache,
    private readonly sampleSize: number = SCORE_BACKGROUND_SAMPLE,
    /** Injected for tests; production always samples the live collection. */
    private readonly sample: (collection: string, maxVectors: number) => Promise<number[][]> = async (c, n) =>
      (sampleVectors as SampleFn)(this.qdrant, c, n),
  ) {}

  async getBackgroundState(collection: string): Promise<"none" | "missing-background" | "complete"> {
    const stats = this.statsCache.load(collection);
    if (!stats) return "none";
    return stats.scoreBackground ? "complete" : "missing-background";
  }

  async backfillScoreBackground(collection: string): Promise<boolean> {
    // No stats file means there is nothing to write the background into. The
    // run that computes stats in the first place will measure it directly.
    const stats = this.statsCache.load(collection);
    if (!stats) return false;

    try {
      const background = computeScoreBackground(await this.sample(collection, this.sampleSize));
      if (!background) return false;

      // save() always writes the current file version, so an older file on disk
      // is lifted while the background is stored — the read path upcasts v4/v5
      // in memory but never rewrites them.
      this.statsCache.save(collection, { ...stats, scoreBackground: background }, stats.payloadFieldKeys);
      return true;
    } catch (error) {
      // A collection that cannot be sampled must not fail the reindex: the
      // background stays absent and confidence stays unavailable until a later
      // run succeeds.
      console.error("[StatsMigration] Failed to sample collection score background:", error);
      return false;
    }
  }
}
