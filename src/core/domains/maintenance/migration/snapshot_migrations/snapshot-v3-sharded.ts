import type { Migration, SnapshotStore, StepResult } from "../types.js";

/**
 * Migrates snapshot from v2 (single JSON with fileMetadata) to sharded format.
 *
 * v2 stores { fileMetadata: Record<string, {mtime, size, hash}>, codebasePath }.
 * This migration backs up the old file, filters out missing files via statFile,
 * writes the sharded format, then deletes the old file.
 */
export class SnapshotV3Sharded implements Migration {
  readonly name = "snapshot-v3-sharded";
  readonly version = 3;

  constructor(private readonly store: SnapshotStore) {}

  async apply(): Promise<StepResult> {
    const data = await this.store.readV2();
    if (data === null) {
      return { applied: ["no v2 data — skipped"] };
    }

    const { fileMetadata, codebasePath } = data;
    const files = new Map<string, { mtime: number; size: number; hash: string }>();
    const applied: string[] = [];

    for (const [relativePath, meta] of Object.entries(fileMetadata)) {
      const absolutePath = `${codebasePath}/${relativePath}`;
      const stat = await this.store.statFile(absolutePath);

      if (stat === null) {
        applied.push(`skipped ${relativePath} (not found)`);
        continue;
      }

      files.set(relativePath, meta);
      applied.push(`migrated ${relativePath}`);
    }

    await this.store.backup();
    await this.store.writeSharded(codebasePath, files);
    await this.store.deleteOld();

    return { applied };
  }
}
