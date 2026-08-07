import type { Migration, StatsStore, StepResult } from "../types.js";

/**
 * Backfill the collection's score background into an existing stats file.
 *
 * Version 6 of the stats cache added `scoreBackground` — the similarity scale
 * search confidence is measured against. Files written before it, and files
 * written by a version that could not measure it, carry no background, and
 * confidence is then omitted from every search response with nothing to
 * explain the silence.
 *
 * The measurement reads the collection that is already there: a bounded vector
 * sample and cosines over disjoint pairs. That is why this belongs in a
 * migration rather than behind a reindex prompt — there is nothing to re-embed.
 */
export class StatsV6ScoreBackground implements Migration {
  readonly name = "stats-v6-score-background";
  readonly version = 6;

  constructor(
    private readonly collection: string,
    private readonly store: StatsStore,
  ) {}

  async apply(): Promise<StepResult> {
    const stored = await this.store.backfillScoreBackground(this.collection);
    // A sample too small to measure is not a failure: the collection is simply
    // too sparse to have a similarity scale yet. Report nothing applied and let
    // a later run — with more points — try again.
    return { applied: stored ? ["scoreBackground"] : [] };
  }
}
