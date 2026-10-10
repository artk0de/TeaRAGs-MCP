/**
 * `CollectionIdleEvictionTracker` (bd tea-rags-mcp-nlls, split out of
 * `GraphDbClientPool` in 0qaht.38): a cached collection is released once it has
 * been idle past `idleMs` with no op in flight — never mid-op, never before its
 * clock started.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import { CollectionIdleEvictionTracker } from "../../../../src/core/adapters/duckdb/collection-idle-eviction.js";
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
