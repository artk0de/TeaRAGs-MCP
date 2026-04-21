import {
  STATS_ACCUMULATOR_KEYS,
  type PointContext,
  type StatsAccumulator,
  type StatsAccumulatorDescriptor,
  type StatsPoint,
} from "../../../../contracts/types/stats-accumulator.js";
import { readPayloadPath } from "./utils.js";

/** Distinct relativePaths for points that carry git timestamp data. */
export class GitDataPathsAccumulator implements StatsAccumulator<Set<string>> {
  private readonly paths: Set<string> = new Set();

  accept(point: StatsPoint, ctx: PointContext): void {
    const firstCreated = readPayloadPath(point.payload, "git.file.firstCreatedAt");
    if (typeof firstCreated === "number" && firstCreated > 0 && ctx.relPath) {
      this.paths.add(ctx.relPath);
    }
  }

  result(): Set<string> {
    return this.paths;
  }
}

export const gitDataPathsDescriptor: StatsAccumulatorDescriptor<Set<string>> = {
  key: STATS_ACCUMULATOR_KEYS.GIT_DATA_PATHS,
  factory: () => new GitDataPathsAccumulator(),
};
