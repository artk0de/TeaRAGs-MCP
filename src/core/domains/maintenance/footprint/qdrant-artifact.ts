import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { INDEXING_METADATA_ID } from "../../../contracts/constants.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

export class QdrantArtifact implements CollectionArtifact {
  readonly id = "qdrant" as const;
  readonly addressing = "physical" as const;
  constructor(private readonly qdrant: QdrantManager) {}

  async clone(ctx: FootprintContext): Promise<void> {
    const snapshotName = await this.qdrant.createSnapshot(ctx.source.physicalName);
    try {
      const location = this.qdrant.snapshotDownloadUrl(ctx.source.physicalName, snapshotName);
      await this.qdrant.recoverFromSnapshot(ctx.target.physicalName, location);
      // Before the alias: until it exists no run can address the clone, so the
      // patch is on the marker from the first instant one can.
      if (ctx.targetIndexingMarkerPatch) {
        await this.qdrant.setPayload(
          ctx.target.physicalName,
          { ...ctx.targetIndexingMarkerPatch },
          { points: [INDEXING_METADATA_ID], wait: true },
        );
      }
      await this.qdrant.aliases.createAlias(ctx.target.logicalName, ctx.target.physicalName);
    } finally {
      await this.qdrant.deleteSnapshot(ctx.source.physicalName, snapshotName).catch(() => undefined);
    }
  }

  /**
   * The two steps are NOT equally optional. Dropping the alias is cleanup that
   * routinely 404s — a legacy unversioned collection never had one — so it stays
   * swallowed and never blocks the step after it. Deleting the physical
   * collection IS the job, and its reason has to reach the caller: a purge that
   * can only report "the collection is still there" instead of "network down"
   * makes the user guess. The worktree teardown wraps every `remove` in its own
   * `.catch`, so the throw changes nothing for it.
   */
  async remove(ctx: FootprintContext): Promise<void> {
    await this.qdrant.aliases.deleteAlias(ctx.target.logicalName).catch(() => undefined);
    await this.qdrant.deleteCollection(ctx.target.physicalName);
  }
}
