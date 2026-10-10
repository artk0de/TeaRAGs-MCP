/**
 * Path leases held by in-process replacers of a codegraph database path (bd
 * tea-rags-mcp-r4veq), one settle-on-release promise per collection. Split out
 * of `GraphDbClientPool` (0qaht.38): the pool's acquire waits out a lease
 * before it hands out or opens a client, and its replacers — `removeCollection`,
 * `cloneDatabase` — run under `withLeases`. No lease costs one `Map.get`.
 */

import type { PhysicalCollectionName } from "../../contracts/types/collection-identity.js";

export class CodegraphPathLeases {
  private readonly pathLeases = new Map<PhysicalCollectionName, Promise<void>>();

  /** Whether a replacer holds the path's lease right now. */
  isHeld(collectionName: PhysicalCollectionName): boolean {
    return this.pathLeases.has(collectionName);
  }

  /** Wait until no replacer holds the path's lease. */
  async waitForRelease(collectionName: PhysicalCollectionName): Promise<void> {
    // Looped: a lease that settles may be followed by the next replacer's.
    for (let lease = this.pathLeases.get(collectionName); lease; lease = this.pathLeases.get(collectionName)) {
      await lease;
    }
  }

  /**
   * Hold the path leases of `collectionNames` while `replace` runs (bd
   * tea-rags-mcp-r4veq). Leases are taken in sorted order, so two replacers
   * sharing paths (a clone A→B racing one B→A) cannot deadlock, and always
   * released, even when `replace` throws.
   */
  async withLeases<T>(collectionNames: PhysicalCollectionName[], replace: () => Promise<T>): Promise<T> {
    const releases: (() => void)[] = [];
    try {
      for (const collectionName of [...new Set(collectionNames)].sort()) {
        releases.push(await this.takePathLease(collectionName));
      }
      return await replace();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  /** Wait for the current holder of the path's lease, if any, then take it. */
  private async takePathLease(collectionName: PhysicalCollectionName): Promise<() => void> {
    for (let held = this.pathLeases.get(collectionName); held; held = this.pathLeases.get(collectionName)) {
      await held;
    }
    let settle!: () => void;
    const lease = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.pathLeases.set(collectionName, lease);
    return () => {
      if (this.pathLeases.get(collectionName) === lease) this.pathLeases.delete(collectionName);
      settle();
    };
  }
}
