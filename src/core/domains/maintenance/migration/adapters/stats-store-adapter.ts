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
import { sampleVectors, scrollAllPoints } from "../../../../adapters/qdrant/scroll.js";
import type { StatsPoint } from "../../../../contracts/types/stats-accumulator.js";
import type { CollectionSignalStats, PayloadSignalDescriptor } from "../../../../contracts/types/trajectory.js";
import { computeScoreBackground } from "../../../../infra/score-background.js";
import type { StatsCache } from "../../../../infra/stats-cache.js";
import { judgeStatsContract } from "../../drift/stats-contract-drift.js";
import type { StatsStore } from "../types.js";

/** Matches the sample size the indexing path uses, so both paths agree. */
export const SCORE_BACKGROUND_SAMPLE = 1200;

/**
 * Recomputes a collection's stats from points already stored.
 *
 * Supplied by the api composition root, because the only honest implementation
 * is `computeCollectionStats` — the same function indexing calls — and this
 * domain may not import the ingest domain to reach it. Injecting the function
 * keeps ONE percentile formula in the process: a second implementation here
 * would drift from the indexing one the first time either changed, and the
 * symptom would be a migrated collection whose labels disagree with a
 * reindexed one.
 */
export type CollectionStatsRecompute = (points: StatsPoint[]) => CollectionSignalStats;

export class StatsStoreAdapter implements StatsStore {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly statsCache: StatsCache,
    private readonly sampleSize: number = SCORE_BACKGROUND_SAMPLE,
    /** Injected for tests; production always samples the live collection. */
    private readonly sample: (collection: string, maxVectors: number) => Promise<number[][]> = async (c, n) =>
      sampleVectors(this.qdrant, c, n),
    /**
     * Absent in the constructions that only need the score-background backfill.
     * Without it the file-scope recompute has no formula to run, so it reports
     * every collection as already sampled per file rather than asking for a
     * migration it cannot perform — an unperformable migration would be
     * re-attempted on every reindex, forever.
     */
    private readonly recomputeStats?: CollectionStatsRecompute,
    /** The descriptors whose `stats` declarations the persisted sample is judged against. */
    private readonly statsSignals: readonly PayloadSignalDescriptor[] = [],
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

  /**
   * Delegates to the SAME judgement the drift monitor reports from
   * (`judgeStatsContract`). Two implementations of "is this sample still the
   * right sample" would eventually disagree, and the failure mode is nasty in
   * both directions: prime reporting a drift no reindex ever clears, or
   * clearing one it never reported.
   *
   * The one thing decided here rather than there: with no recompute wired,
   * every collection reports `current`. A migration that cannot be performed
   * would otherwise be re-attempted on every reindex, forever.
   */
  async getStatsContractState(collection: string): Promise<"none" | "stale" | "current"> {
    if (!this.recomputeStats) return "current";
    const judgement = judgeStatsContract(this.statsCache.load(collection), this.statsSignals);
    if (!judgement) return "none";
    return judgement.stale.length > 0 ? "stale" : "current";
  }

  async rebuildStatsFromPayload(collection: string): Promise<boolean> {
    const existing = this.statsCache.load(collection);
    if (!existing || !this.recomputeStats) return false;

    try {
      const rebuilt = this.recomputeStats(await scrollAllPoints(this.qdrant, collection));

      // The background is measured from VECTORS, not payload, so nothing about
      // this recompute invalidates it — carrying it across saves a 1200-vector
      // sample, and v6 has already run by the time v7 does (StatsMigrator
      // reports the older gap first) so it is present whenever it can be.
      if (existing.scoreBackground) rebuilt.scoreBackground = existing.scoreBackground;

      // The payload-key stamp belongs to the run that wrote the payload, and
      // drift compares it against the descriptors of whichever process is
      // asking. Restamping it here would let a migration flip a collection's
      // drift verdict as a side effect of recomputing percentiles — and the
      // process running the migration may well be the one with different
      // trajectory flags (see domains/maintenance/CLAUDE.md).
      this.statsCache.save(collection, rebuilt, existing.payloadFieldKeys);
      return true;
    } catch (error) {
      // A collection that cannot be scrolled must not fail the reindex: the
      // stats keep their chunk-weighted percentiles and the migration is
      // re-attempted on the next run.
      console.error("[StatsMigration] Failed to recompute file-scope collection stats:", error);
      return false;
    }
  }
}
