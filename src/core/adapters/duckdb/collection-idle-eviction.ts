/**
 * Per-collection idle eviction (bd tea-rags-mcp-nlls), split out of
 * `GraphDbClientPool` (0qaht.38): the idle clock and in-flight op refcount per
 * collection, and the unref'd poller that releases a cached client idle past
 * `idleMs` with no op in flight. The pool owns the cache and the release; this
 * tracker only decides WHEN.
 */

import type { PhysicalCollectionName } from "../../contracts/types/collection-identity.js";

/**
 * Per-collection idle-eviction tuning (bd tea-rags-mcp-nlls). `pollMs` mirrors
 * the daemon idle watcher's 5s cadence by default.
 */
export interface GraphDbClientPoolIdleEviction {
  /** Evict a collection's cached client after this long with no op. */
  idleMs: number;
  /** How often the eviction pass runs. */
  pollMs?: number;
}

/** What an eviction pass reads and acts on — the pool's client cache. */
export interface CollectionIdleEvictionTarget {
  /** Collections with a cached client, i.e. the eviction candidates. */
  cachedCollections: () => PhysicalCollectionName[];
  /** Close and drop the collection's cached client; true when one was evicted. */
  release: (physicalCollectionName: PhysicalCollectionName) => Promise<boolean>;
}

export class CollectionIdleEvictionTracker {
  /**
   * Idle-eviction clock: the last time an op for the collection started or
   * completed (bd tea-rags-mcp-nlls).
   */
  private readonly lastUsedByCollection = new Map<PhysicalCollectionName, number>();
  /**
   * Ops currently running against a cached client, so eviction NEVER closes a
   * connection mid-op. `GraphDbClientPool#runCollectionOp` owns the refcount;
   * `acquire` alone (the daemon handshake's open-and-drop) is not an in-flight op.
   */
  private readonly opsInFlightByCollection = new Map<PhysicalCollectionName, number>();
  private idleEvictionTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly eviction: GraphDbClientPoolIdleEviction,
    private readonly target: CollectionIdleEvictionTarget,
  ) {}

  /** Start the eviction poller (`unref()`'d — never keeps the process alive). */
  start(): void {
    this.idleEvictionTimer = setInterval(() => {
      void this.evictIdle().catch(() => undefined);
    }, this.eviction.pollMs ?? 5_000);
    this.idleEvictionTimer.unref();
  }

  /** Stamp the collection's idle clock with now. */
  stampUse(physicalCollectionName: PhysicalCollectionName): void {
    this.lastUsedByCollection.set(physicalCollectionName, Date.now());
  }

  /** An op starts: stamp the clock and raise the in-flight refcount. */
  beginOp(physicalCollectionName: PhysicalCollectionName): void {
    this.lastUsedByCollection.set(physicalCollectionName, Date.now());
    this.opsInFlightByCollection.set(
      physicalCollectionName,
      (this.opsInFlightByCollection.get(physicalCollectionName) ?? 0) + 1,
    );
  }

  /** An op ends: stamp the clock again and drop the in-flight refcount. */
  endOp(physicalCollectionName: PhysicalCollectionName): void {
    this.lastUsedByCollection.set(physicalCollectionName, Date.now());
    const remaining = (this.opsInFlightByCollection.get(physicalCollectionName) ?? 1) - 1;
    if (remaining <= 0) this.opsInFlightByCollection.delete(physicalCollectionName);
    else this.opsInFlightByCollection.set(physicalCollectionName, remaining);
  }

  /** Forget the collection's idle clock — its cached client is gone. */
  forget(physicalCollectionName: PhysicalCollectionName): void {
    this.lastUsedByCollection.delete(physicalCollectionName);
  }

  /** Forget every clock and refcount — the pool closed everything. */
  clear(): void {
    this.lastUsedByCollection.clear();
    this.opsInFlightByCollection.clear();
  }

  /**
   * Close and drop every cached client whose collection has been idle past
   * `idleMs` with no op in flight. Eviction goes through the pool's `release`,
   * so the `onCollectionClientClosed` parity hook fires (the daemon's memory
   * governor takes the entry with it) and the next acquire lazily re-opens.
   */
  async evictIdle(): Promise<void> {
    const now = Date.now();
    for (const physicalCollectionName of this.target.cachedCollections()) {
      if ((this.opsInFlightByCollection.get(physicalCollectionName) ?? 0) > 0) continue;
      const lastUsed = this.lastUsedByCollection.get(physicalCollectionName);
      if (lastUsed === undefined || now - lastUsed < this.eviction.idleMs) continue;
      const idleSeconds = Math.round((now - lastUsed) / 1000);
      const evicted = await this.target.release(physicalCollectionName);
      if (evicted) {
        process.stderr.write(
          `[tea-rags] codegraph pool: evicted idle pool entry for ${physicalCollectionName} after ${idleSeconds}s idle\n`,
        );
      }
    }
  }
}
