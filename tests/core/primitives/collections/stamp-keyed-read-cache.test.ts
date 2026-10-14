/**
 * `StampKeyedReadCache` (bd tea-rags-mcp-lnor0, generalising nehn5's
 * `IndexedSymbolRowsCache`): whole-database reads held by a long-lived process
 * per (scope, read kind, key), valid only while the database's write stamp has
 * not moved. The stamp is taken BEFORE the read, a failed read is never held,
 * no stamp means no caching, and memory is bounded per kind and per scope.
 */
import { describe, expect, it, vi } from "vitest";

import { deepFreeze, StampKeyedReadCache } from "../../../../src/core/primitives/collections/index.js";

const slot = (kind: string, key?: string, scope = "code_a") => ({ scope, kind, ...(key !== undefined ? { key } : {}) });

describe("StampKeyedReadCache (bd tea-rags-mcp-lnor0)", () => {
  it("serves a second read under an unchanged stamp without loading again", async () => {
    const cache = new StampKeyedReadCache();
    const load = vi.fn(async () => ({ edges: [1] }));

    const first = await cache.read(slot("graph"), "gen-1", load);
    const second = await cache.read(slot("graph"), "gen-1", load);

    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads again once a write moved the stamp", async () => {
    const cache = new StampKeyedReadCache();
    const load = vi.fn(async () => ({}));

    await cache.read(slot("graph"), "gen-1", load);
    await cache.read(slot("graph"), "gen-2", load);
    await cache.read(slot("graph"), "gen-2", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a new stamp drops every read the scope held under the old one", async () => {
    const cache = new StampKeyedReadCache();
    const graph = vi.fn(async () => ({}));
    const rows = vi.fn(async () => []);

    await cache.read(slot("graph"), "gen-1", graph);
    await cache.read(slot("rows"), "gen-1", rows);
    await cache.read(slot("graph"), "gen-2", graph);
    await cache.read(slot("rows"), "gen-2", rows);

    expect(rows).toHaveBeenCalledTimes(2);
  });

  it("separates keys of one kind, kinds of one scope, and scopes", async () => {
    const cache = new StampKeyedReadCache();
    const load = vi.fn(async () => ({}));

    await cache.read(slot("memberEdges", '["python"]'), "gen-1", load);
    await cache.read(slot("memberEdges", '["ruby"]'), "gen-1", load);
    await cache.read(slot("typeRows", '["python"]'), "gen-1", load);
    await cache.read(slot("memberEdges", '["python"]', "code_b"), "gen-1", load);
    await cache.read(slot("memberEdges", '["python"]'), "gen-1", load);

    expect(load).toHaveBeenCalledTimes(4);
  });

  it("an in-flight read is shared, not started twice", async () => {
    const cache = new StampKeyedReadCache();
    const load = vi.fn(async () => ({}));

    const [a, b] = await Promise.all([
      cache.read(slot("graph"), "gen-1", load),
      cache.read(slot("graph"), "gen-1", load),
    ]);

    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a write racing the read leaves the entry under the older stamp: the next caller loads again", async () => {
    const cache = new StampKeyedReadCache();
    let stamp = "gen-1";
    const load = vi.fn(async () => {
      stamp = "gen-2"; // a write committed while the read was in flight
      return {};
    });

    await cache.read(slot("graph"), stamp, load);
    await cache.read(slot("graph"), stamp, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never holds a failed read", async () => {
    const cache = new StampKeyedReadCache();
    const load = vi.fn().mockRejectedValueOnce(new Error("daemon down")).mockResolvedValueOnce({ ok: true });

    await expect(cache.read(slot("graph"), "gen-1", load)).rejects.toThrow("daemon down");
    await expect(cache.read(slot("graph"), "gen-1", load)).resolves.toEqual({ ok: true });
    await cache.read(slot("graph"), "gen-1", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a load that throws synchronously rejects and is not held", async () => {
    const cache = new StampKeyedReadCache();
    const load = vi.fn(async (): Promise<object> => {
      throw new Error("sync");
    });

    await expect(cache.read(slot("graph"), "gen-1", load)).rejects.toThrow("sync");
    await expect(cache.read(slot("graph"), "gen-1", load)).rejects.toThrow("sync");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("caches nothing without a stamp", async () => {
    const cache = new StampKeyedReadCache();
    const load = vi.fn(async () => ({}));

    await cache.read(slot("graph"), undefined, load);
    await cache.read(slot("graph"), undefined, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bounds the keys one kind holds: the least recently read key is evicted", async () => {
    const cache = new StampKeyedReadCache({ maxKeysPerKind: 2 });
    const load = vi.fn(async () => ({}));

    await cache.read(slot("typeRows", "a"), "gen-1", load);
    await cache.read(slot("typeRows", "b"), "gen-1", load);
    await cache.read(slot("typeRows", "a"), "gen-1", load); // a is now the most recent
    await cache.read(slot("graph"), "gen-1", load); // another kind does not count against typeRows
    await cache.read(slot("typeRows", "c"), "gen-1", load); // evicts b
    expect(load).toHaveBeenCalledTimes(4);

    await cache.read(slot("typeRows", "a"), "gen-1", load);
    await cache.read(slot("graph"), "gen-1", load);
    expect(load).toHaveBeenCalledTimes(4);
    await cache.read(slot("typeRows", "b"), "gen-1", load);
    expect(load).toHaveBeenCalledTimes(5);
  });

  it("bounds the scopes it holds: the least recently read collection is dropped", async () => {
    const cache = new StampKeyedReadCache({ maxScopes: 2 });
    const load = vi.fn(async () => ({}));

    await cache.read(slot("graph", undefined, "code_v1"), "s", load);
    await cache.read(slot("graph", undefined, "code_v2"), "s", load);
    await cache.read(slot("graph", undefined, "code_v1"), "s", load);
    await cache.read(slot("graph", undefined, "code_v3"), "s", load); // drops code_v2
    expect(load).toHaveBeenCalledTimes(3);

    await cache.read(slot("graph", undefined, "code_v1"), "s", load);
    expect(load).toHaveBeenCalledTimes(3);
    await cache.read(slot("graph", undefined, "code_v2"), "s", load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});

describe("deepFreeze (bd tea-rags-mcp-lnor0)", () => {
  it("freezes every object and array reachable from the value, and returns it", () => {
    const value = { files: [{ relPath: "a.ts", scopes: ["A"] }], meta: { n: 1 } };

    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value.files[0].scopes)).toBe(true);
    expect(() => value.files.push({ relPath: "b.ts", scopes: [] })).toThrow(TypeError);
    expect(() => {
      value.meta.n = 2;
    }).toThrow(TypeError);
  });

  it("passes primitives and null through", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(3)).toBe(3);
  });
});
