/**
 * `GraphFacade#findCoChanged` (bd tea-rags-mcp-l1ot.1) — addressing, the
 * read-handle lifecycle shared with every graph tool, and the liveness guard:
 * the project root the registry resolves becomes the `pathExists` predicate,
 * so a PARTNER deleted from the working tree after the last index run never
 * surfaces (owner acceptance: "must never return a partner that is not in the
 * current live path set"). The guard applies to partners — a queried file's
 * own history stays answerable even when the file itself is gone.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

function readerPool(graphDb: Record<string, unknown>) {
  if (typeof graphDb.close !== "function") graphDb.close = vi.fn().mockResolvedValue(undefined);
  const acquireReader = vi.fn().mockResolvedValue({ graphDb, symbolTable: {} });
  return { pool: { acquireReader, peek: vi.fn() } as unknown as GraphDbClientPool, acquireReader };
}

/** A pool whose collection has no graph database at all — the honest-empty path. */
function absentPool() {
  const acquireReader = vi.fn().mockRejectedValue(new Error("no database"));
  return {
    pool: { acquireReader, hasDatabase: vi.fn().mockReturnValue(false), peek: vi.fn() } as unknown as GraphDbClientPool,
  };
}

function projectRegistry(path: string | undefined): CollectionRegistry {
  return {
    findByName: vi.fn(() => (path === undefined ? null : { name: "proj", collectionName: "code_x", path })),
    findByPath: vi.fn(() => null),
    list: vi.fn(() => []),
  } as unknown as CollectionRegistry;
}

const cochangeGraph = {
  meta: {
    head: "h",
    fingerprint: "f",
    builtAt: 1,
    windowSince: 0,
    commitCount: 1,
    bundleCount: 1,
    admittedBundleCount: 1,
    maxFilesPerBundle: 5,
    minSupport: 2,
    maxPartnersPerFile: 20,
    sessionGapMinutes: null,
  },
  edges: [
    {
      relPathA: "a.ts",
      relPathB: "b.ts",
      support: 3,
      confidenceAB: 0.75,
      confidenceBA: 0.5,
      lift: 4.5,
      lastCoChangeAt: 1_700_000_000,
      sampleCommits: ["s1"],
      structurallyLinked: false,
    },
    {
      relPathA: "a.ts",
      relPathB: "c.ts",
      support: 2,
      confidenceAB: 0.5,
      confidenceBA: 0.4,
      lift: 3.0,
      lastCoChangeAt: 1_699_000_000,
      sampleCommits: ["s0"],
      structurallyLinked: true,
    },
  ],
};

describe("GraphFacade#findCoChanged", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cochange-facade-"));
    writeFileSync(join(dir, "a.ts"), "export {};\n");
    writeFileSync(join(dir, "c.ts"), "export {};\n");
    // b.ts is deliberately absent — it was deleted after the last index run.
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops a partner whose file is gone from the working tree, keeps the alive one", async () => {
    const graphDb = { readTemporalCochangeGraph: vi.fn().mockResolvedValue(cochangeGraph) };
    const { pool } = readerPool(graphDb);
    const facade = new GraphFacade({ pool, collectionRegistry: projectRegistry(dir) });

    const res = await facade.findCoChanged({ project: "proj", files: ["a.ts"] });

    expect(res.built).toBe(true);
    // b.ts was deleted after the last index run; its stored edge must not surface.
    expect(res.files[0].partners.map((p) => p.relPath)).toEqual(["c.ts"]);
    expect(res.files[0].partners[0].structurallyLinked).toBe(true);
  });

  it("answers a deleted queried file with its surviving history — the guard is on partners, not the query", async () => {
    const graphDb = { readTemporalCochangeGraph: vi.fn().mockResolvedValue(cochangeGraph) };
    const { pool } = readerPool(graphDb);
    const facade = new GraphFacade({ pool, collectionRegistry: projectRegistry(dir) });

    const res = await facade.findCoChanged({ project: "proj", files: ["b.ts"] });

    expect(res.files[0].relPath).toBe("b.ts");
    expect(res.files[0].inGraph).toBe(true);
    // b.ts's only stored pair is (a.ts, b.ts) — a.ts is alive, so the history survives.
    expect(res.files[0].partners.map((p) => p.relPath)).toEqual(["a.ts"]);
  });

  it("skips the liveness guard when the address carries no project root", async () => {
    const graphDb = { readTemporalCochangeGraph: vi.fn().mockResolvedValue(cochangeGraph) };
    const { pool } = readerPool(graphDb);
    const facade = new GraphFacade({ pool, collectionRegistry: projectRegistry(undefined) });

    const res = await facade.findCoChanged({ collection: "code_x", files: ["a.ts"] });

    expect(res.files[0].partners.map((p) => p.relPath)).toEqual(["b.ts", "c.ts"]);
  });

  it("strips a leading ./ from the requested files", async () => {
    const graphDb = { readTemporalCochangeGraph: vi.fn().mockResolvedValue(cochangeGraph) };
    const { pool } = readerPool(graphDb);
    const facade = new GraphFacade({ pool, collectionRegistry: projectRegistry(undefined) });

    const res = await facade.findCoChanged({ collection: "code_x", files: ["./a.ts"] });

    expect(res.files[0].relPath).toBe("a.ts");
    expect(res.files[0].inGraph).toBe(true);
  });

  it("answers built:false when the collection has no graph database at all", async () => {
    const facade = new GraphFacade({
      pool: absentPool().pool,
      collectionRegistry: projectRegistry(undefined),
    });

    const res = await facade.findCoChanged({ collection: "code_x", files: ["a.ts"] });

    expect(res).toEqual({ built: false, files: [{ relPath: "a.ts", inGraph: false, partners: [] }] });
  });

  it("rethrows a read failure on a database that exists", async () => {
    const acquireReader = vi.fn().mockRejectedValue(new Error("Conflicting lock is held"));
    const facade = new GraphFacade({
      pool: {
        acquireReader,
        hasDatabase: vi.fn().mockReturnValue(true),
        peek: vi.fn(),
      } as unknown as GraphDbClientPool,
      collectionRegistry: projectRegistry(undefined),
    });

    await expect(facade.findCoChanged({ collection: "code_x", files: ["a.ts"] })).rejects.toThrow(/Conflicting lock/);
  });
});
