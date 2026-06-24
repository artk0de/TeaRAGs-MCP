import { QuarantineStore } from "../../ingest/sync/quarantine-store.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

export class QuarantineArtifact implements CollectionArtifact {
  readonly id = "quarantine" as const;
  constructor(private readonly snapshotBaseDir: string) {}

  async clone(ctx: FootprintContext): Promise<void> {
    await new QuarantineStore(this.snapshotBaseDir, ctx.source.logicalName).cloneTo(ctx.target.logicalName);
  }

  async remove(ctx: FootprintContext): Promise<void> {
    await new QuarantineStore(this.snapshotBaseDir, ctx.target.logicalName).clearAll();
  }
}
