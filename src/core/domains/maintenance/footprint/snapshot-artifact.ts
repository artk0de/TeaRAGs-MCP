import { ShardedSnapshotManager } from "../../ingest/sync/snapshot/sharded-snapshot.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

export class SnapshotArtifact implements CollectionArtifact {
  readonly id = "snapshot" as const;
  constructor(private readonly baseDir: string) {}

  async clone(ctx: FootprintContext): Promise<void> {
    const src = new ShardedSnapshotManager(this.baseDir, ctx.source.logicalName);
    await src.cloneTo(ctx.target.logicalName, ctx.target.path);
  }

  async remove(ctx: FootprintContext): Promise<void> {
    await new ShardedSnapshotManager(this.baseDir, ctx.target.logicalName).delete();
  }
}
