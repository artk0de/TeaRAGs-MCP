/**
 * TrajectoryVersionDriftMonitor — reports when a trajectory's INDEXED payload
 * was computed by an older revision of its algorithm than the build running
 * (bd tea-rags-mcp-xi2r9).
 *
 * The payload-key axis cannot see this: the git chunk walk changing how it
 * orders commits or which rows it attributes leaves every `git.*` key in place
 * while the values move. The stamp is `CollectionEntry.trajectoryVersions`,
 * written by the run that rebuilt a trajectory for every point
 * (`IndexingOps`); the current side is each enrichment provider's
 * `algorithmVersion`, resolved by the composition root. The values are
 * enrichment-owned and the chunk set does not move, so the remedy is that
 * trajectory's recompute, collection-wide.
 */

import type { IndexDriftFinding, IndexDriftMonitor } from "./monitor.js";

/**
 * The version an unstamped trajectory is read as. Every index written before
 * the stamp existed was computed by the revision the code was at then, which is
 * 1 — so the first bump fires on all of them, which is the point.
 */
const SEEDED_TRAJECTORY_VERSION = 1;

/** Registry surface the monitor needs: the stamp the last qualifying run wrote. */
export interface TrajectoryVersionStampReader {
  get: (collectionName: string) => { trajectoryVersions?: Record<string, number> } | null;
}

export class TrajectoryVersionDriftMonitor implements IndexDriftMonitor {
  readonly axis = "trajectoryVersions" as const;

  constructor(
    private readonly registry: TrajectoryVersionStampReader,
    /** Algorithm version per enrichment provider key the running build enriches with. */
    private readonly currentVersions: ReadonlyMap<string, number>,
  ) {}

  check(collectionName: string): IndexDriftFinding[] {
    const entry = this.registry.get(collectionName);
    if (!entry) return [];
    return [...this.currentVersions].flatMap(([trajectory, current]) => {
      const indexed = entry.trajectoryVersions?.[trajectory] ?? SEEDED_TRAJECTORY_VERSION;
      if (indexed === current) return [];
      return [
        {
          axis: this.axis,
          subject: `${trajectory}.algorithm`,
          indexed: String(indexed),
          current: String(current),
          remedy: { kind: "recompute", trajectories: new Set([trajectory]), languages: null },
        },
      ];
    });
  }
}
