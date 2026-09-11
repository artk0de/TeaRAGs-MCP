/**
 * SchemaDriftMonitor — detects payload schema changes between server version and indexed data.
 *
 * One axis of `IndexDriftMonitor`: it reports WHICH payload keys moved and what
 * each of them costs to repopulate. Whether the reader has already been told is
 * `IndexDriftReporter`'s business, not this class's.
 */

import type { PayloadKeyOwner } from "../../../contracts/types/trajectory.js";
import { resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import type { IndexDriftFinding, IndexDriftMonitor } from "./monitor.js";
import { resolvePayloadKeyRemedy } from "./remedy.js";
import { formatIndexDriftReport, IndexDriftReporter } from "./report.js";
import { checkSchemaDrift, type SchemaDrift } from "./schema-drift.js";

export class SchemaDriftMonitor implements IndexDriftMonitor {
  readonly axis = "payloadKeys" as const;

  constructor(
    private readonly statsCache: StatsCache,
    private readonly currentPayloadKeys: string[],
    /**
     * Per-key trajectory attribution, when the caller can supply it. Lets the
     * warning name the narrowest command that repopulates the drifted keys
     * instead of always demanding a full reindex. Omitted by callers that hold
     * only a flat key list — every key is then unattributed, which escalates.
     */
    private readonly payloadKeyOwners?: readonly PayloadKeyOwner[],
  ) {}

  /**
   * One finding per drifted key. Added keys carry the cost of repopulating that
   * key alone, so the fold can keep the command as narrow as the drift allows;
   * removed keys carry none — nothing reads a key the build no longer declares.
   */
  check(collectionName: string): IndexDriftFinding[] {
    const stats = this.statsCache.load(collectionName);
    const drift = checkSchemaDrift(stats?.payloadFieldKeys, this.currentPayloadKeys);
    if (!drift) return [];
    const ownerByKey = new Map((this.payloadKeyOwners ?? []).map((o) => [o.key, o]));
    return [
      ...drift.added.map((key) => ({
        axis: this.axis,
        subject: key,
        indexed: "absent",
        current: "declared",
        remedy: resolvePayloadKeyRemedy(key, ownerByKey),
      })),
      ...drift.removed.map((key) => ({
        axis: this.axis,
        subject: key,
        indexed: "recorded",
        current: "absent",
        remedy: { kind: "none" } as const,
      })),
    ];
  }

  /** Check drift for a path. Returns null when nothing moved. */
  async checkAndConsume(path: string): Promise<string | null> {
    try {
      return this.checkByCollectionName(resolveCollectionName(await validatePath(path)));
    } catch {
      return null;
    }
  }

  /** Check drift synchronously when collection name is already known. */
  checkByCollectionName(collectionName: string): string | null {
    const report = new IndexDriftReporter([this]).checkByCollectionName(collectionName);
    return report && formatIndexDriftReport(report);
  }

  /** Expose drift detection for testing. */
  static detectDrift(cachedKeys: string[] | undefined, currentKeys: string[]): SchemaDrift | null {
    return checkSchemaDrift(cachedKeys, currentKeys);
  }
}
