/**
 * SchemaDriftMonitor — detects payload schema changes between server version and indexed data.
 *
 * One axis of `IndexDriftMonitor`: it reports WHICH payload keys moved and what
 * each of them costs to repopulate. Whether the reader has already been told is
 * `IndexDriftReporter`'s business, not this class's.
 */

import type { StatsCache } from "../../../adapters/filesystem/stats-cache.js";
import type { PayloadKeyOwner } from "../../../contracts/types/trajectory.js";
import type { IndexDriftFinding, IndexDriftMonitor } from "./monitor.js";
import { resolvePayloadKeyRemedy } from "./remedy.js";
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
    /**
     * Trajectory families (`codegraph` covers `codegraph.symbols` and
     * `codegraph.temporal`) the collection's own effective env turns off. The
     * declared key set belongs to the whole process; a collection whose next
     * run would not write a family's keys is not missing them.
     */
    private readonly disabledTrajectoryFamilies?: (collectionName: string) => readonly string[],
  ) {}

  /**
   * One finding per drifted key. Added keys carry the cost of repopulating that
   * key alone, so the fold can keep the command as narrow as the drift allows;
   * removed keys carry none — nothing reads a key the build no longer declares.
   */
  check(collectionName: string): IndexDriftFinding[] {
    const stats = this.statsCache.load(collectionName);
    const ownerByKey = new Map((this.payloadKeyOwners ?? []).map((o) => [o.key, o]));
    const drift = checkSchemaDrift(stats?.payloadFieldKeys, this.declaredKeysFor(collectionName, ownerByKey));
    if (!drift) return [];
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

  private declaredKeysFor(collectionName: string, ownerByKey: ReadonlyMap<string, PayloadKeyOwner>): string[] {
    const families = this.disabledTrajectoryFamilies?.(collectionName) ?? [];
    if (families.length === 0) return this.currentPayloadKeys;
    const isDisabled = (trajectory: string | undefined): boolean =>
      trajectory !== undefined &&
      families.some((family) => trajectory === family || trajectory.startsWith(`${family}.`));
    return this.currentPayloadKeys.filter((key) => !isDisabled(ownerByKey.get(key)?.trajectory));
  }

  /** Expose drift detection for testing. */
  static detectDrift(cachedKeys: string[] | undefined, currentKeys: string[]): SchemaDrift | null {
    return checkSchemaDrift(cachedKeys, currentKeys);
  }
}
