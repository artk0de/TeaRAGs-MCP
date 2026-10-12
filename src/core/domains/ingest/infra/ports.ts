/**
 * Behaviour ports of the ingest infra's collection-indexing lock (6oah1 I1,
 * decision N-2 = a).
 *
 * The lock is the surface other components lean on — bootstrap wires it into
 * the footprint, api/internal/ops claims collections through it, pipeline's
 * status module probes it — and the Stable Dependencies Principle wants a
 * component that others depend on to be abstract. These interfaces are the
 * consumed surface, collected from those call sites; the concrete
 * `CollectionIndexingLock` implements them, type-only holders outside
 * ingest/infra type against the port, and constructor sites (bootstrap,
 * ingest-facade) keep the concrete class.
 *
 * The port lives here rather than in contracts because placing it inside the
 * stable component is what moves main-sequence distance: its consumer set —
 * bootstrap and api — shares ingest/infra's stability band. The
 * StatsRecomputeService port lives in contracts instead because explore, a
 * different domain, consumes it (plan note g-13).
 */
import type { IndexingLockRemovalOutcome } from "../../../contracts/types/footprint.js";

/**
 * {@link CollectionIndexingLockPort#inspectLiveness}: `alive` / `dead` — the
 * lock's holder judged by the takeover rule; `unknown` — no lock to judge.
 */
export type IndexingLockLiveness = "alive" | "dead" | "unknown";

/**
 * A lock this process holds, as its consumers see it: whether the claim
 * superseded a dead writer, and how to give the collection back.
 */
export interface HeldCollectionIndexingLockPort {
  /** This claim replaced a lock whose holder was judged dead (bd tea-rags-mcp-nhd1s). */
  readonly tookOverStaleLock: boolean;
  /** Stop the heartbeat and remove the lock file — only if it is still this lock. Idempotent. */
  release: () => Promise<void>;
}

/**
 * The cross-process claim one index operation holds on a collection: claim it
 * (`tryAcquire`), hand back the claim (`HeldCollectionIndexingLockPort`),
 * tear down a dead run's lock (`removeIfStale`), or ask who holds it
 * (`inspectLiveness`).
 */
export interface CollectionIndexingLockPort {
  /**
   * Claim the collection for one operation. Resolves the held lock, or
   * `undefined` when a live run holds it.
   */
  tryAcquire: (collectionName: string, operation: string) => Promise<HeldCollectionIndexingLockPort | undefined>;
  /** Remove the collection's lock when the run that holds it is dead; leave it when alive. */
  removeIfStale: (collectionName: string) => Promise<IndexingLockRemovalOutcome>;
  /** Read-only verdict on the run holding the collection's lock; `unknown` when there is no lock. */
  inspectLiveness: (collectionName: string) => Promise<IndexingLockLiveness>;
}
