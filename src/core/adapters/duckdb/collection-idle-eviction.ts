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
  /**
   * How long a collection must have been idle before a release request from
   * another build's daemon is honoured (bd tea-rags-mcp-8noie). Defaults to
   * {@link RELEASE_REQUEST_IDLE_GRACE_MS}; tests shorten it.
   */
  releaseRequestGraceMs?: number;
}

/**
 * Idle grace before a release REQUEST is honoured (bd tea-rags-mcp-8noie).
 *
 * 3 s, because it has to sit between two numbers. Above the gap between two
 * ops of one active session: a review's or enrichment pass's ops follow each
 * other within milliseconds, and a write admitted behind another one starts in
 * the same tick the previous one ends — so an active session is never cut
 * between ops, and two builds active on one collection hand the lock over at
 * most once per 3 s of quiet instead of thrashing. Far below the 60 s idle
 * window (`DEFAULT_IDLE_EVICT_MS`) the waiter otherwise sits out: a waiter
 * polling once a second gets the file within about grace + one interval.
 */
export const RELEASE_REQUEST_IDLE_GRACE_MS = 3_000;

/**
 * The holder's answer to a release request (bd tea-rags-mcp-8noie):
 * `released` — the cached client was closed through the ordinary release;
 * `notHeld` — no cached client to release; `declined` — busy, kept open
 * (`idleEvictionOff`: a pool without idle eviction keeps clients until it
 * closes, so it has no idle clock to judge by).
 */
export type CollectionReleaseRequestOutcome =
  | { kind: "released" }
  | { kind: "notHeld" }
  | { kind: "declined"; reason: "opInFlight" | "withinGrace" | "idleEvictionOff" };

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
   * Honour a release request from another build's daemon waiting on the
   * collection's file lock (bd tea-rags-mcp-8noie): release it now when no op
   * is in flight AND it has been idle past the grace, else decline. The check
   * and the target's `release` start in one synchronous step — the pool marks
   * the client retired before its first await — so no op can pin the client in
   * between. Same `release` path as the idle poller: never the stale-retire
   * path, which deletes the WAL by path (bd tea-rags-mcp-amh78).
   */
  async releaseOnRequest(physicalCollectionName: PhysicalCollectionName): Promise<CollectionReleaseRequestOutcome> {
    if (!this.target.cachedCollections().includes(physicalCollectionName)) return { kind: "notHeld" };
    if ((this.opsInFlightByCollection.get(physicalCollectionName) ?? 0) > 0) {
      return { kind: "declined", reason: "opInFlight" };
    }
    const lastUsed = this.lastUsedByCollection.get(physicalCollectionName);
    const graceMs = this.eviction.releaseRequestGraceMs ?? RELEASE_REQUEST_IDLE_GRACE_MS;
    if (lastUsed !== undefined && Date.now() - lastUsed < graceMs) return { kind: "declined", reason: "withinGrace" };
    return (await this.target.release(physicalCollectionName)) ? { kind: "released" } : { kind: "notHeld" };
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
