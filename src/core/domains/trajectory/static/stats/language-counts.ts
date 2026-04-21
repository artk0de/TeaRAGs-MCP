import {
  STATS_ACCUMULATOR_KEYS,
  type PointContext,
  type StatsAccumulator,
  type StatsAccumulatorDescriptor,
  type StatsPoint,
} from "../../../../contracts/types/stats-accumulator.js";

export class LanguageCountsAccumulator implements StatsAccumulator<Record<string, number>> {
  private readonly counts: Record<string, number> = {};

  accept(_point: StatsPoint, ctx: PointContext): void {
    if (typeof ctx.lang === "string") {
      this.counts[ctx.lang] = (this.counts[ctx.lang] ?? 0) + 1;
    }
  }

  result(): Record<string, number> {
    return this.counts;
  }
}

export const languageCountsDescriptor: StatsAccumulatorDescriptor<Record<string, number>> = {
  key: STATS_ACCUMULATOR_KEYS.LANGUAGE_COUNTS,
  factory: () => new LanguageCountsAccumulator(),
};
