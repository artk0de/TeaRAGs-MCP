import type { Migration, SnapshotStore, StepResult } from "../types.js";

/**
 * Migrates snapshot from v1 (file hashes only) to sharded format.
 *
 * v1 stores only { fileHashes, codebasePath }.
 * This migration stats each file to get mtime/size, then writes sharded format.
 */
export class SnapshotV1ToV2 implements Migration {
  readonly name = "snapshot-v1-to-v2";
  readonly version = 2;

  constructor(private readonly store: SnapshotStore) {}

  async apply(): Promise<StepResult> {
    const data = await this.store.readV1();
    if (data === null) {
      return { applied: ["no v1 data — skipped"] };
    }

    const { fileHashes, codebasePath } = data;
    const files = new Map<string, { mtime: number; size: number; hash: string }>();
    const applied: string[] = [];

    for (const [relativePath, hash] of Object.entries(fileHashes)) {
      const absolutePath = `${codebasePath}/${relativePath}`;
      const stat = await this.store.statFile(absolutePath);

      if (stat === null) {
        applied.push(`skipped ${relativePath} (not found)`);
        continue;
      }

      files.set(relativePath, { mtime: stat.mtimeMs, size: stat.size, hash });
      applied.push(`migrated ${relativePath}`);
    }

    await this.store.writeSharded(codebasePath, files);
    return { applied };
  }
}
