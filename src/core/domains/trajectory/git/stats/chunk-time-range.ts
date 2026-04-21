import {
  STATS_ACCUMULATOR_KEYS,
  type PointContext,
  type StatsAccumulator,
  type StatsAccumulatorDescriptor,
  type StatsPoint,
} from "../../../../contracts/types/stats-accumulator.js";
import { readPayloadPath } from "./utils.js";

export interface ChunkTimeRangeResult {
  chunkOldest: number | undefined;
  chunkNewest: number | undefined;
}

export class ChunkTimeRangeAccumulator implements StatsAccumulator<ChunkTimeRangeResult> {
  private chunkOldest: number | undefined;
  private chunkNewest: number | undefined;

  accept(point: StatsPoint, _ctx: PointContext): void {
    const lastModified = readPayloadPath(point.payload, "git.chunk.lastModifiedAt");
    if (typeof lastModified === "number" && lastModified > 0) {
      this.chunkOldest = this.chunkOldest === undefined ? lastModified : Math.min(this.chunkOldest, lastModified);
      this.chunkNewest = this.chunkNewest === undefined ? lastModified : Math.max(this.chunkNewest, lastModified);
    }
  }

  result(): ChunkTimeRangeResult {
    return { chunkOldest: this.chunkOldest, chunkNewest: this.chunkNewest };
  }
}

export const chunkTimeRangeDescriptor: StatsAccumulatorDescriptor<ChunkTimeRangeResult> = {
  key: STATS_ACCUMULATOR_KEYS.CHUNK_TIME_RANGE,
  factory: () => new ChunkTimeRangeAccumulator(),
};
