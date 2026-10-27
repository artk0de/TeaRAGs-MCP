import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { SnapshotArtifactStoreFactory } from "../../../contracts/index.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

/**
 * Files beside the sharded directory: the legacy v1/v2 snapshot, its migration
 * backup, checkpoints, and the recovery marker older builds wrote.
 */
const LEGACY_SNAPSHOT_SUFFIXES = [
  ".json",
  ".json.backup",
  ".checkpoint.json",
  ".checkpoint.json.tmp",
  ".recovery-complete",
] as const;

/**
 * Temp entries an interrupted write leaves: the sharded swap dir
 * `<logical>.tmp.<ts>` and the legacy snapshot's `<logical>.json.tmp.<ts>.<rand>`.
 */
function isInterruptedWrite(entry: string, logicalName: string): boolean {
  return entry.startsWith(`${logicalName}.tmp.`) || entry.startsWith(`${logicalName}.json.tmp.`);
}

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
    const entries = ctx.knownStoreEntries ?? (await readdir(this.baseDir).catch(() => []));
    const doomed = [
      ...LEGACY_SNAPSHOT_SUFFIXES.map((suffix) => `${logicalName}${suffix}`),
      ...entries.filter((entry) => isInterruptedWrite(entry, logicalName)),
    ];
    await Promise.all(doomed.map(async (entry) => rm(join(this.baseDir, entry), { recursive: true, force: true })));
  }
}
