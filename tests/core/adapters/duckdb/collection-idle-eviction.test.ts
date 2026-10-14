/**
 * `CollectionIdleEvictionTracker` (bd tea-rags-mcp-nlls, split out of
 * `GraphDbClientPool` in 0qaht.38): a cached collection is released once it has
 * been idle past `idleMs` with no op in flight — never mid-op, never before its
 * clock started.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import {
  CollectionIdleEvictionTracker,
  RELEASE_REQUEST_IDLE_GRACE_MS,
} from "../../../../src/core/adapters/duckdb/collection-idle-eviction.js";
import type { PhysicalCollectionName } from "../../../../src/core/contracts/types/collection-identity.js";

const a = fixturePhysicalCollectionName("code_a");
const b = fixturePhysicalCollectionName("code_b");

function trackerOver(cached: PhysicalCollectionName[]) {
  const released: PhysicalCollectionName[] = [];
  const tracker = new CollectionIdleEvictionTracker(
    { idleMs: 1_000 },
    {
      cachedCollections: () => cached,
      release: async (name) => {
        released.push(name);
        return true;
      },
    },
  );
  return { tracker, released };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CollectionIdleEvictionTracker", () => {
  it("releases a collection idle past idleMs and keeps a fresh one", async () => {
    const { tracker, released } = trackerOver([a, b]);
    tracker.stampUse(a);
    vi.advanceTimersByTime(1_500);
    tracker.stampUse(b);
    await tracker.evictIdle();
    expect(released).toEqual([a]);
  });

  it("never releases a collection with an op in flight, and restarts its clock when the op ends", async () => {
    const { tracker, released } = trackerOver([a]);
    tracker.beginOp(a);
    vi.advanceTimersByTime(5_000);
    await tracker.evictIdle();
    expect(released).toEqual([]);
    tracker.endOp(a);
    await tracker.evictIdle();
    expect(released).toEqual([]);
    vi.advanceTimersByTime(1_500);
    await tracker.evictIdle();
    expect(released).toEqual([a]);
  });

  it("does not release a collection whose clock never started or was forgotten", async () => {
    const { tracker, released } = trackerOver([a, b]);
    tracker.stampUse(b);
    tracker.forget(b);
    vi.advanceTimersByTime(5_000);
    await tracker.evictIdle();
    expect(released).toEqual([]);
  });
});

/**
 * A release request from another build's daemon waiting on the collection's
 * file lock (bd tea-rags-mcp-8noie). Honoured only when the collection has no
 * op in flight AND has been idle past the grace — the release the idle poller
 * runs, without waiting out the whole idle window.
 */
describe("CollectionIdleEvictionTracker#releaseOnRequest (8noie)", () => {
  function trackerWithGrace(cached: PhysicalCollectionName[], releaseRequestGraceMs?: number) {
    const released: PhysicalCollectionName[] = [];
    const tracker = new CollectionIdleEvictionTracker(
      { idleMs: 60_000, releaseRequestGraceMs },
      {
        cachedCollections: () => cached,
        release: async (name) => {
          released.push(name);
          return true;
        },
      },
    );
    return { tracker, released };
  }

  it("releases a collection idle past the grace, long before its idle window", async () => {
    const { tracker, released } = trackerWithGrace([a], 3_000);
    tracker.beginOp(a);
    tracker.endOp(a);
    vi.advanceTimersByTime(3_001);
    expect(await tracker.releaseOnRequest(a)).toEqual({ kind: "released" });
    expect(released).toEqual([a]);
  });

  it("declines while an op is in flight, however long ago it started", async () => {
    const { tracker, released } = trackerWithGrace([a], 3_000);
    tracker.beginOp(a);
    vi.advanceTimersByTime(30_000);
    expect(await tracker.releaseOnRequest(a)).toEqual({ kind: "declined", reason: "opInFlight" });
    expect(released).toEqual([]);
  });

  it("declines within the grace after the last op", async () => {
    const { tracker, released } = trackerWithGrace([a], 3_000);
    tracker.beginOp(a);
    tracker.endOp(a);
    vi.advanceTimersByTime(2_999);
    expect(await tracker.releaseOnRequest(a)).toEqual({ kind: "declined", reason: "withinGrace" });
    expect(released).toEqual([]);
  });

  it("answers notHeld for a collection with no cached client, releasing nothing", async () => {
    const { tracker, released } = trackerWithGrace([b], 3_000);
    expect(await tracker.releaseOnRequest(a)).toEqual({ kind: "notHeld" });
    expect(released).toEqual([]);
  });

  it("defaults the grace to RELEASE_REQUEST_IDLE_GRACE_MS", async () => {
    const { tracker } = trackerWithGrace([a]);
    tracker.stampUse(a);
    vi.advanceTimersByTime(RELEASE_REQUEST_IDLE_GRACE_MS - 1);
    expect(await tracker.releaseOnRequest(a)).toEqual({ kind: "declined", reason: "withinGrace" });
    vi.advanceTimersByTime(2);
    expect(await tracker.releaseOnRequest(a)).toEqual({ kind: "released" });
  });

  /**
   * Livelock invariant: two builds both active on one collection ask each other
   * to release on every poll. A request honoured only under 0-in-flight + grace
   * can never close the client under a running op (a write included), nor
   * between two ops a session issues back to back — each side hands the lock
   * over only once its own work has gone quiet for the grace.
   */
  it("never interrupts an active session: every request during back-to-back ops is declined", async () => {
    const { tracker, released } = trackerWithGrace([a], 3_000);
    for (let op = 0; op < 20; op++) {
      tracker.beginOp(a);
      expect(await tracker.releaseOnRequest(a)).toEqual({ kind: "declined", reason: "opInFlight" });
      vi.advanceTimersByTime(500);
      tracker.endOp(a);
      vi.advanceTimersByTime(1_000);
      expect(await tracker.releaseOnRequest(a)).toEqual({ kind: "declined", reason: "withinGrace" });
    }
    expect(released).toEqual([]);
  });
});
