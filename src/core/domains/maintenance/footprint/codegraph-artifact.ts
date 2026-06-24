import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

export class CodegraphArtifact implements CollectionArtifact {
  readonly id = "codegraph" as const;
  constructor(private readonly pool: GraphDbClientPool) {}

  async clone(ctx: FootprintContext): Promise<void> {
    if (!ctx.source.codegraphEnabled) return;
    await this.pool.cloneDatabase(ctx.source.physicalName, ctx.target.physicalName);
  }

  async remove(ctx: FootprintContext): Promise<void> {
    await this.pool.removeCollection(ctx.target.physicalName);
  }
}
