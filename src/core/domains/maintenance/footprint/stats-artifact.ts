import type { StatsCache } from "../../../infra/stats-cache.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

export class StatsArtifact implements CollectionArtifact {
  readonly id = "stats" as const;
  constructor(private readonly statsCache: StatsCache) {}

  async clone(ctx: FootprintContext): Promise<void> {
    this.statsCache.clone(ctx.source.logicalName, ctx.target.logicalName);
  }

  async remove(ctx: FootprintContext): Promise<void> {
    this.statsCache.invalidate(ctx.target.logicalName);
  }
}
