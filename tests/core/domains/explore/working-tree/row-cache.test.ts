/**
 * `WorkingTreePassRowCache`: a byte-bounded row cache that a full pass over a
 * working set larger than its bound cannot flush. An entry used by a pass still
 * in flight is never evicted for that pass's misses; a miss that finds nothing
 * else to evict is not admitted.
 */

import { describe, expect, it } from "vitest";

import { WorkingTreePassRowCache } from "../../../../../src/core/domains/explore/working-tree/index.js";

describe("WorkingTreePassRowCache", () => {
  const keys = Array.from({ length: 10 }, (_, i) => `f${String(i)}`);

  /** One full pass over `keys` (100 bytes each): returns the keys served from memory. */
  const passOver = (cache: WorkingTreePassRowCache<string>, version = "v1"): string[] => {
    const pass = cache.beginPass();
    const hits: string[] = [];
    for (const key of keys) {
      if (cache.get(`${key}:${version}`, pass) !== undefined) hits.push(key);
      else cache.set(`${key}:${version}`, key, 100, pass);
      expect(cache.heldBytes).toBeLessThanOrEqual(400);
    }
    cache.endPass(pass);
    return hits;
  };

  it("should keep a stable resident set across repeated passes over a working set 2.5x its bound", () => {
    const cache = new WorkingTreePassRowCache<string>(400);

    expect(passOver(cache)).toEqual([]);
    const second = passOver(cache);
    const third = passOver(cache);

    expect(second.length / keys.length).toBeGreaterThanOrEqual(0.3);
    expect(third).toEqual(second);
    expect(cache.heldBytes).toBeLessThanOrEqual(400);
  });

  it("should evict entries no pass in flight has used, least recently used first", () => {
    const cache = new WorkingTreePassRowCache<string>(300);
    const first = cache.beginPass();
    cache.set("a", "a", 100, first);
    cache.set("b", "b", 100, first);
    cache.set("c", "c", 100, first);
    cache.endPass(first);

    const second = cache.beginPass();
    expect(cache.get("b", second)).toBe("b");
    expect(cache.set("d", "d", 100, second)).toBe(true); // a, c unused this pass — a is older
    expect(cache.get("a", second)).toBeUndefined();
    expect(cache.get("c", second)).toBe("c");
    expect(cache.set("e", "e", 100, second)).toBe(false); // b, c, d all used by this pass
    expect(cache.get("e", second)).toBeUndefined();
    expect(cache.heldBytes).toBe(300);
    cache.endPass(second);
  });

  it("should protect entries of every pass still in flight", () => {
    const cache = new WorkingTreePassRowCache<string>(200);
    const one = cache.beginPass();
    const two = cache.beginPass();
    cache.set("a", "a", 100, one);
    cache.set("b", "b", 100, two);

    expect(cache.set("c", "c", 100, two)).toBe(false);
    cache.endPass(one);
    expect(cache.set("c", "c", 100, two)).toBe(true);
    expect(cache.get("a", two)).toBeUndefined();
    expect(cache.get("b", two)).toBe("b");
    cache.endPass(two);
  });

  it("should not evict anything for an entry it cannot admit", () => {
    const cache = new WorkingTreePassRowCache<string>(300);
    const first = cache.beginPass();
    cache.set("a", "a", 100, first);
    cache.endPass(first);
    const second = cache.beginPass();
    cache.set("b", "b", 100, second);
    cache.set("c", "c", 100, second);

    expect(cache.set("big", "big", 250, second)).toBe(false); // freeing a alone leaves 300 - 100 + 250 > 300
    expect(cache.get("a", second)).toBe("a");
    expect(cache.set("huge", "huge", 301, second)).toBe(false);
    cache.endPass(second);
  });

  it("should displace a stale content version with the new one", () => {
    const cache = new WorkingTreePassRowCache<string>(400);
    const first = cache.beginPass();
    for (const key of keys.slice(0, 4)) cache.set(`${key}:v1`, key, 100, first);
    cache.endPass(first);

    const second = cache.beginPass();
    for (const key of keys.slice(1, 4)) expect(cache.get(`${key}:v1`, second)).toBe(key);
    expect(cache.set("f0:v2", "f0", 100, second)).toBe(true);
    cache.endPass(second);

    const third = cache.beginPass();
    expect(cache.get("f0:v2", third)).toBe("f0");
    expect(cache.get("f0:v1", third)).toBeUndefined();
    expect(cache.heldBytes).toBe(400);
    cache.endPass(third);
  });

  it("should replace a key's value and forget everything on clear", () => {
    const cache = new WorkingTreePassRowCache<string>(300);
    const pass = cache.beginPass();
    cache.set("a", "old", 100, pass);
    cache.set("a", "new", 150, pass);
    expect(cache.get("a", pass)).toBe("new");
    expect(cache.heldBytes).toBe(150);
    cache.endPass(pass);

    cache.clear();
    expect(cache.heldBytes).toBe(0);
    expect(cache.get("a", cache.beginPass())).toBeUndefined();
  });
});
