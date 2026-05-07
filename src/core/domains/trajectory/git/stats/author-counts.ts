import {
  STATS_ACCUMULATOR_KEYS,
  type PointContext,
  type StatsAccumulator,
  type StatsAccumulatorDescriptor,
  type StatsPoint,
} from "../../../../contracts/types/stats-accumulator.js";
import { readPayloadPath } from "./utils.js";

export class RecentAuthorCountsAccumulator implements StatsAccumulator<Map<string, number>> {
  private readonly counts: Map<string, number> = new Map();

  accept(point: StatsPoint, _ctx: PointContext): void {
    const author = readPayloadPath(point.payload, "git.file.recentDominantAuthor");
    if (typeof author === "string") {
      this.counts.set(author, (this.counts.get(author) ?? 0) + 1);
    }
  }

  result(): Map<string, number> {
    return this.counts;
  }
}

export const recentAuthorCountsDescriptor: StatsAccumulatorDescriptor<Map<string, number>> = {
  key: STATS_ACCUMULATOR_KEYS.RECENT_AUTHOR_COUNTS,
  factory: () => new RecentAuthorCountsAccumulator(),
};

export class BlameAuthorCountsAccumulator implements StatsAccumulator<Map<string, number>> {
  private readonly counts: Map<string, number> = new Map();

  accept(point: StatsPoint, _ctx: PointContext): void {
    const author = readPayloadPath(point.payload, "git.file.blameDominantAuthor");
    if (typeof author === "string") {
      this.counts.set(author, (this.counts.get(author) ?? 0) + 1);
    }
  }

  result(): Map<string, number> {
    return this.counts;
  }
}

export const blameAuthorCountsDescriptor: StatsAccumulatorDescriptor<Map<string, number>> = {
  key: STATS_ACCUMULATOR_KEYS.BLAME_AUTHOR_COUNTS,
  factory: () => new BlameAuthorCountsAccumulator(),
};
