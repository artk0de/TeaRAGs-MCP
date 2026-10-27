import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { SnapshotArtifactStoreFactory } from "../../../contracts/index.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

/** Pre-sharded snapshot files beside the sharded directory: legacy v1/v2 snapshot, its migration backup, checkpoints. */
const LEGACY_SNAPSHOT_SUFFIXES = [".json", ".json.backup", ".checkpoint.json", ".checkpoint.json.tmp"] as const;

export class SnapshotArtifact implements CollectionArtifact {
  readonly id = "snapshot" as const;
  readonly addressing = "logical" as const;
  constructor(
    private readonly baseDir: string,
    private readonly makeStore: SnapshotArtifactStoreFactory,
  ) {}

  async clone(ctx: FootprintContext): Promise<void> {
    await this.makeStore(this.baseDir, ctx.source.logicalName).cloneTo(ctx.target.logicalName, ctx.target.path);
  }

  async remove(ctx: FootprintContext): Promise<void> {
    const { logicalName } = ctx.target;
    await this.makeStore(this.baseDir, logicalName).delete();
    await Promise.all(
      LEGACY_SNAPSHOT_SUFFIXES.map(async (suffix) =>
        rm(join(this.baseDir, `${logicalName}${suffix}`), { force: true }),
      ),
    );
  }
}
