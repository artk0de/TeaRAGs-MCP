import { describe, expect, it } from "vitest";

import { ByteBoundedLru } from "../../../src/core/infra/byte-bounded-lru.js";

describe("ByteBoundedLru", () => {
  it("bounds by the bytes its entries declare, not by how many there are", () => {
    const cache = new ByteBoundedLru<number>(5_000);
    for (let i = 0; i < 5_000; i++) cache.set(`k${String(i)}`, i, 1);

    expect(cache.get("k0")).toBe(0);
    expect(cache.get("k4999")).toBe(4_999);
    expect(cache.heldBytes).toBe(5_000);
  });

  it("evicts the least recently used entries once the bound is exceeded, a read counting as a use", () => {
    const cache = new ByteBoundedLru<string>(30);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    cache.set("c", "C", 10);
    expect(cache.get("a")).toBe("A");

    cache.set("d", "D", 15);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("d")).toBe("D");
    expect(cache.heldBytes).toBe(25);
  });

  it("does not keep an entry larger than the whole bound, and drops what that key held before", () => {
    const cache = new ByteBoundedLru<string>(10);
    cache.set("a", "small", 4);
    cache.set("b", "kept", 4);

    cache.set("a", "huge", 11);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("kept");
    expect(cache.heldBytes).toBe(4);
  });

  it("re-setting a key replaces its bytes instead of adding to them", () => {
    const cache = new ByteBoundedLru<string>(10);
    cache.set("a", "one", 6);
    cache.set("a", "two", 6);

    expect(cache.get("a")).toBe("two");
    expect(cache.heldBytes).toBe(6);
  });

  it("delete and clear release the bytes", () => {
    const cache = new ByteBoundedLru<string>(10);
    cache.set("a", "A", 3);
    cache.set("b", "B", 3);

    cache.delete("a");
    expect(cache.heldBytes).toBe(3);
    cache.clear();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.heldBytes).toBe(0);
  });
});
