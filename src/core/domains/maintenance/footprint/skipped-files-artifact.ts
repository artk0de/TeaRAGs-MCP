import type { SkippedFilesArtifactStoreFactory } from "../../../contracts/index.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

/**
 * The deterministic-skip record (`<logical>.skipped.json`, bd
 * tea-rags-mcp-6xdwe). Alias-keyed like the quarantine: one record per
 * collection, surviving a version bump. A clone carries it so the seeded
 * worktree index still tells its deliberate skips from lost files.
 */
export class SkippedFilesArtifact implements CollectionArtifact {
  readonly id = "skipped-files" as const;
  readonly addressing = "logical" as const;
  constructor(
    private readonly snapshotBaseDir: string,
    private readonly makeStore: SkippedFilesArtifactStoreFactory,
  ) {}

  async clone(ctx: FootprintContext): Promise<void> {
    await this.makeStore(this.snapshotBaseDir, ctx.source.logicalName).cloneTo(ctx.target.logicalName);
  }

  async remove(ctx: FootprintContext): Promise<void> {
    await this.makeStore(this.snapshotBaseDir, ctx.target.logicalName).clearAll();
  }
}
