import {
  STATS_ACCUMULATOR_KEYS,
  type PointContext,
  type StatsAccumulator,
  type StatsAccumulatorDescriptor,
  type StatsPoint,
} from "../../../../contracts/types/stats-accumulator.js";

export class DistinctPathsAccumulator implements StatsAccumulator<Set<string>> {
  private readonly paths: Set<string> = new Set();

  accept(_point: StatsPoint, ctx: PointContext): void {
    if (ctx.relPath) {
      this.paths.add(ctx.relPath);
    }
  }

  result(): Set<string> {
    return this.paths;
  }
}

export const distinctPathsDescriptor: StatsAccumulatorDescriptor<Set<string>> = {
  key: STATS_ACCUMULATOR_KEYS.DISTINCT_PATHS,
  factory: () => new DistinctPathsAccumulator(),
};
