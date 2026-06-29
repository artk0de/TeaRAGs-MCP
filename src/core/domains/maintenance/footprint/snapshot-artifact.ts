import type { SnapshotArtifactStoreFactory } from "../../../contracts/index.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

export class SnapshotArtifact implements CollectionArtifact {
  readonly id = "snapshot" as const;
  constructor(
    private readonly baseDir: string,
    private readonly makeStore: SnapshotArtifactStoreFactory,
  ) {}

  async clone(ctx: FootprintContext): Promise<void> {
    await this.makeStore(this.baseDir, ctx.source.logicalName).cloneTo(ctx.target.logicalName, ctx.target.path);
  }

  async remove(ctx: FootprintContext): Promise<void> {
    await this.makeStore(this.baseDir, ctx.target.logicalName).delete();
  }
}
