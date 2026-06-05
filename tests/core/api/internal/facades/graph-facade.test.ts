import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { CollectionNotProvidedError, ProjectNotRegisteredError } from "../../../../../src/core/api/errors.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { CollectionRegistry } from "../../../../../src/core/infra/registry/index.js";

/**
 * Build a fake pool that returns the same graphDb (+ trivial symbolTable
 * stub) for every collection name. Keeps each test focused on the
 * facade's mapping behaviour without exercising real DuckDB I/O.
 *
 * Reads route through `acquireReader` (mode-aware: daemon client in prod,
 * in-process READ_ONLY attach in direct/test mode); the facade resolves the
 * address triad (collection > project > path) via the registry and closes the
 * returned `graphDb` after each query, so the stub graphDb gets a no-op
 * `close` injected when absent.
 */
function fakePool(graphDb: Record<string, unknown>): GraphDbClientPool {
  if (typeof graphDb.close !== "function") graphDb.close = vi.fn().mockResolvedValue(undefined);
  const handle = {
    graphDb,
    symbolTable: {} as unknown as never,
  };
  return {
    acquireReader: vi.fn().mockResolvedValue(handle),
    peek: vi.fn().mockReturnValue(handle),
  } as unknown as GraphDbClientPool;
}

/**
 * Minimal CollectionRegistry stub — only the methods resolveCollection()
 * touches (findByName + findByPath + list). Returns the entry passed via
 * the map.
 */
function fakeRegistry(entries: Record<string, { collectionName: string; path: string }>): CollectionRegistry {
  return {
    findByName: vi.fn((name: string) => {
      const entry = entries[name];
      return entry ? { ...entry, name } : null;
    }),
    findByPath: vi.fn((path: string) => {
      for (const [name, entry] of Object.entries(entries)) {
        if (entry.path === path) return { ...entry, name };
      }
      return null;
    }),
    list: vi.fn(() => Object.entries(entries).map(([name, e]) => ({ ...e, name }))),
  } as unknown as CollectionRegistry;
}

describe("GraphFacade", () => {
  it("getCallers delegates to GraphDbClient and respects limit", async () => {
    const graphDb = {
      getCallers: vi.fn().mockResolvedValue([
        { sourceSymbolId: "A.f", sourceRelPath: "src/a.ts", callExpression: "B.x()" },
        { sourceSymbolId: "C.g", sourceRelPath: "src/c.ts", callExpression: "B.x()" },
      ]),
      getCallees: vi.fn(),
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: fakeRegistry({}) });
    const response = await facade.getCallers({ path: "/proj", symbolId: "B.x", limit: 50 });
    expect(graphDb.getCallers).toHaveBeenCalledWith("B.x");
    expect(response.callers).toHaveLength(2);
  });

  it("getCallers truncates results when over limit", async () => {
    const graphDb = {
      getCallers: vi.fn().mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({
          sourceSymbolId: `A${i}.f`,
          sourceRelPath: `src/a${i}.ts`,
          callExpression: "B.x()",
        })),
      ),
      getCallees: vi.fn(),
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: fakeRegistry({}) });
    const response = await facade.getCallers({ path: "/proj", symbolId: "B.x", limit: 3 });
    expect(response.callers).toHaveLength(3);
  });

  it("resolves an alias to its active versioned collection before acquiring the read handle", async () => {
    // Codegraph DuckDB files are versioned (code_x_v4.duckdb); the Qdrant alias
    // "code_x" must resolve to the active versioned collection so the read path
    // opens the file the write path populated. Without this, get_callers reads
    // the empty unversioned file and returns [] despite real method edges.
    const graphDb = { getCallers: vi.fn().mockResolvedValue([]), getCallees: vi.fn() };
    const pool = fakePool(graphDb);
    const facade = new GraphFacade({
      pool,
      collectionRegistry: fakeRegistry({}),
      resolveActiveCollection: async (name: string) => (name === "code_x" ? "code_x_v4" : name),
    });
    await facade.getCallers({ collection: "code_x", symbolId: "B.x" });
    expect(pool.acquireReader).toHaveBeenCalledWith("code_x_v4");
  });

  it("falls back to the addressed collection when alias resolution fails", async () => {
    // Resolution failure (Qdrant unreachable, alias-list error) must not abort
    // the read — it degrades to the addressed name rather than throwing.
    const graphDb = { getCallers: vi.fn().mockResolvedValue([]), getCallees: vi.fn() };
    const pool = fakePool(graphDb);
    const facade = new GraphFacade({
      pool,
      collectionRegistry: fakeRegistry({}),
      resolveActiveCollection: async () => {
        throw new Error("alias list failed");
      },
    });
    await facade.getCallers({ collection: "code_x", symbolId: "B.x" });
    expect(pool.acquireReader).toHaveBeenCalledWith("code_x");
  });

  it("getCallees delegates with the default limit of 50", async () => {
    const callees = Array.from({ length: 75 }, (_, i) => ({
      targetSymbolId: `T${i}`,
      targetRelPath: `src/t${i}.ts`,
      callExpression: `T${i}.run()`,
    }));
    const graphDb = {
      getCallers: vi.fn(),
      getCallees: vi.fn().mockResolvedValue(callees),
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: fakeRegistry({}) });
    const response = await facade.getCallees({ path: "/proj", symbolId: "main" });
    expect(graphDb.getCallees).toHaveBeenCalledWith("main");
    expect(response.callees).toHaveLength(50);
  });

  // Slice 2 / B2 — find_cycles MCP path. Facade walks the persisted
  // cg_symbols_cycles table via graphDb.findCycles, then shapes each
  // entry into the DTO (adds derived `length`). Three behavioural cases
  // cover the body:
  //   - non-empty results map cleanly (length matches members.length)
  //   - empty results pass through as { cycles: [] }
  //   - the scope field flows through unchanged
  it("findCycles maps GraphDbClient entries to DTO with derived length field", async () => {
    const graphDb = {
      getCallers: vi.fn(),
      getCallees: vi.fn(),
      findCycles: vi.fn().mockResolvedValue([
        { cycleId: 0, scope: "file", members: ["src/a.ts", "src/b.ts"] },
        { cycleId: 1, scope: "file", members: ["src/x.ts", "src/y.ts", "src/z.ts"] },
      ]),
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: fakeRegistry({}) });
    const response = await facade.findCycles({ path: "/proj", scope: "file" });
    expect(graphDb.findCycles).toHaveBeenCalledWith("file", undefined);
    expect(response.cycles).toHaveLength(2);
    expect(response.cycles[0]).toEqual({
      cycleId: 0,
      scope: "file",
      members: ["src/a.ts", "src/b.ts"],
      length: 2,
    });
    expect(response.cycles[1].length).toBe(3);
  });

  it("findCycles returns empty array when no cycles are persisted (DAG case)", async () => {
    const graphDb = {
      getCallers: vi.fn(),
      getCallees: vi.fn(),
      findCycles: vi.fn().mockResolvedValue([]),
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: fakeRegistry({}) });
    const response = await facade.findCycles({ path: "/proj", scope: "method" });
    expect(graphDb.findCycles).toHaveBeenCalledWith("method", undefined);
    expect(response.cycles).toEqual([]);
  });

  it("findCycles forwards pathPattern through to graphDb.findCycles", async () => {
    const graphDb = {
      getCallers: vi.fn(),
      getCallees: vi.fn(),
      findCycles: vi
        .fn()
        .mockResolvedValue([{ cycleId: 0, scope: "file", members: ["src/core/a.ts", "src/core/b.ts"] }]),
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: fakeRegistry({}) });
    const response = await facade.findCycles({ path: "/proj", scope: "file", pathPattern: "src/core/**" });
    expect(graphDb.findCycles).toHaveBeenCalledWith("file", "src/core/**");
    expect(response.cycles).toHaveLength(1);
  });

  // New behaviour for slice-2 pool wiring: when the per-collection
  // DuckDB can't be opened (lock held by another process, missing
  // file, init failure), the facade surfaces empty results rather
  // than propagating the error to the MCP tool. Mirrors the spec
  // "codegraph optional" guarantee — the MCP server keeps responding.
  it("returns empty response when the pool cannot open the collection", async () => {
    const pool = {
      acquireReader: vi.fn().mockRejectedValue(new Error("lock held")),
      peek: vi.fn().mockReturnValue(undefined),
    } as unknown as GraphDbClientPool;
    const facade = new GraphFacade({ pool, collectionRegistry: fakeRegistry({}) });
    expect(await facade.getCallers({ path: "/proj", symbolId: "X" })).toEqual({ callers: [] });
    expect(await facade.getCallees({ path: "/proj", symbolId: "X" })).toEqual({ callees: [] });
    expect(await facade.findCycles({ path: "/proj", scope: "file" })).toEqual({ cycles: [] });
  });

  // Triad resolution — the three codegraph facade methods accept the same
  // `{ collection, project, path }` mixin every other tea-rags facade uses
  // (resolution priority: collection > project > path). Backward compatible:
  // path-only callers keep working; project alias resolves via registry;
  // explicit collection overrides both.
  describe("triad resolution", () => {
    it("resolves project alias via CollectionRegistry into a Qdrant collection name", async () => {
      const graphDb = {
        getCallers: vi.fn().mockResolvedValue([]),
        getCallees: vi.fn(),
        findCycles: vi.fn(),
      };
      const pool = fakePool(graphDb);
      // resolveCollection guards against stale alias paths — use the
      // current working directory as a known-live anchor so the registry
      // entry's path passes the existence check.
      const registry = fakeRegistry({
        "tea-rags-worktree": { collectionName: "code_abc123", path: process.cwd() },
      });
      const facade = new GraphFacade({ pool, collectionRegistry: registry });

      await facade.getCallers({ project: "tea-rags-worktree", symbolId: "X" });

      // Pool must be queried with the registry-resolved collection name,
      // NOT with a hash of any path.
      expect(pool.acquireReader).toHaveBeenCalledWith("code_abc123");
    });

    it("uses explicit collection name when provided (highest priority)", async () => {
      const graphDb = {
        getCallers: vi.fn(),
        getCallees: vi.fn().mockResolvedValue([]),
        findCycles: vi.fn(),
      };
      const pool = fakePool(graphDb);
      const facade = new GraphFacade({ pool, collectionRegistry: fakeRegistry({}) });

      await facade.getCallees({ collection: "code_explicit", symbolId: "Y" });

      expect(pool.acquireReader).toHaveBeenCalledWith("code_explicit");
    });

    it("priority: collection wins over project when both are supplied", async () => {
      const graphDb = {
        getCallers: vi.fn(),
        getCallees: vi.fn(),
        findCycles: vi.fn().mockResolvedValue([]),
      };
      const pool = fakePool(graphDb);
      const registry = fakeRegistry({
        "some-alias": { collectionName: "code_from_alias", path: "/projects/alias" },
      });
      const facade = new GraphFacade({ pool, collectionRegistry: registry });

      await facade.findCycles({
        collection: "code_explicit",
        project: "some-alias",
        path: "/some/path",
        scope: "file",
      });

      expect(pool.acquireReader).toHaveBeenCalledWith("code_explicit");
    });

    it("falls back to path when neither collection nor project is supplied (backward compat)", async () => {
      const graphDb = {
        getCallers: vi.fn().mockResolvedValue([]),
        getCallees: vi.fn(),
        findCycles: vi.fn(),
      };
      const pool = fakePool(graphDb);
      const facade = new GraphFacade({ pool, collectionRegistry: fakeRegistry({}) });

      await facade.getCallers({ path: "/proj/legacy", symbolId: "Z" });

      // Path mode delegates to resolveCollectionName(path) — a deterministic
      // md5-prefix hash. We just assert the pool was called with SOMETHING
      // and not with the literal path string.
      expect(pool.acquireReader).toHaveBeenCalledTimes(1);
      const calledWith = (pool.acquireReader as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledWith).toMatch(/^code_[0-9a-f]{8}$/);
    });

    it("throws CollectionNotProvidedError (typed InputValidationError) when none of collection/project/path is supplied", async () => {
      const graphDb = { getCallers: vi.fn(), getCallees: vi.fn(), findCycles: vi.fn() };
      const facade = new GraphFacade({
        pool: fakePool(graphDb),
        collectionRegistry: fakeRegistry({}),
      });

      await expect(facade.getCallers({ symbolId: "X" })).rejects.toBeInstanceOf(CollectionNotProvidedError);
      await expect(facade.getCallees({ symbolId: "Y" })).rejects.toBeInstanceOf(CollectionNotProvidedError);
      await expect(facade.findCycles({ scope: "file" })).rejects.toBeInstanceOf(CollectionNotProvidedError);
    });

    it("throws ProjectNotRegisteredError when project alias is unknown", async () => {
      const graphDb = { getCallers: vi.fn(), getCallees: vi.fn(), findCycles: vi.fn() };
      const facade = new GraphFacade({
        pool: fakePool(graphDb),
        collectionRegistry: fakeRegistry({}),
      });

      await expect(facade.getCallers({ project: "unknown", symbolId: "X" })).rejects.toBeInstanceOf(
        ProjectNotRegisteredError,
      );
    });
  });
});
