import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

export class QdrantArtifact implements CollectionArtifact {
  readonly id = "qdrant" as const;
  constructor(private readonly qdrant: QdrantManager) {}

  async clone(ctx: FootprintContext): Promise<void> {
    const snapshotName = await this.qdrant.createSnapshot(ctx.source.physicalName);
    try {
      const location = this.qdrant.snapshotDownloadUrl(ctx.source.physicalName, snapshotName);
      await this.qdrant.recoverFromSnapshot(ctx.target.physicalName, location);
      await this.qdrant.aliases.createAlias(ctx.target.logicalName, ctx.target.physicalName);
    } finally {
      await this.qdrant.deleteSnapshot(ctx.source.physicalName, snapshotName).catch(() => undefined);
    }
  }

  async remove(ctx: FootprintContext): Promise<void> {
    await this.qdrant.aliases.deleteAlias(ctx.target.logicalName).catch(() => undefined);
    await this.qdrant.deleteCollection(ctx.target.physicalName).catch(() => undefined);
  }
}
