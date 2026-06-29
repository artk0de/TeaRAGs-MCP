import type { QuarantineArtifactStoreFactory } from "../../../contracts/index.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

export class QuarantineArtifact implements CollectionArtifact {
  readonly id = "quarantine" as const;
  constructor(
    private readonly snapshotBaseDir: string,
    private readonly makeStore: QuarantineArtifactStoreFactory,
  ) {}

  async clone(ctx: FootprintContext): Promise<void> {
    await this.makeStore(this.snapshotBaseDir, ctx.source.logicalName).cloneTo(ctx.target.logicalName);
  }

  async remove(ctx: FootprintContext): Promise<void> {
    await this.makeStore(this.snapshotBaseDir, ctx.target.logicalName).clearAll();
  }
}
