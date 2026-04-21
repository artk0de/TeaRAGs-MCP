import {
  STATS_ACCUMULATOR_KEYS,
  type PointContext,
  type StatsAccumulator,
  type StatsAccumulatorDescriptor,
  type StatsPoint,
} from "../../../../contracts/types/stats-accumulator.js";

export class ChunkTypeCountsAccumulator implements StatsAccumulator<Record<string, number>> {
  private readonly counts: Record<string, number> = {};

  accept(_point: StatsPoint, ctx: PointContext): void {
    if (typeof ctx.pointChunkType === "string") {
      this.counts[ctx.pointChunkType] = (this.counts[ctx.pointChunkType] ?? 0) + 1;
    }
  }

  result(): Record<string, number> {
    return this.counts;
  }
}

export const chunkTypeCountsDescriptor: StatsAccumulatorDescriptor<Record<string, number>> = {
  key: STATS_ACCUMULATOR_KEYS.CHUNK_TYPE_COUNTS,
  factory: () => new ChunkTypeCountsAccumulator(),
};
