import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { TracePathOps } from "../../../../../src/core/api/internal/ops/trace-path-ops.js";
import { fileScopedSymbolKey } from "../../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";

/**
 * bd tea-rags-mcp-oxnvl — trace_path node identity is `(relPath, symbolId)`.
 *
 * Top-level symbols carry BARE symbolIds, so a codebase with three `BaseTable`
 * files used to walk into one merged graph node: a path could enter through the
 * ui namesake and leave through the admin one, and hydration ("last chunk with
 * that symbolId wins") could stamp a third file's path onto the step.
 */

type ScopedAdjacency = Record<string, [relPath: string, symbolId: string][]>;

function makeGraphDb(adjacency: ScopedAdjacency, symbolPaths: Record<string, string[]>) {
  return {
    getCalleeEdgesScoped: vi.fn(async (refs: { relPath: string; symbolId: string }[]) => {
      const out = new Map<string, { relPath: string; symbolId: string }[]>();
      for (const ref of refs) {
        const key = fileScopedSymbolKey(ref);
        const targets = adjacency[key];
        if (targets) {
          out.set(
            key,
            targets.map(([relPath, symbolId]) => ({ relPath, symbolId })),
          );
        }
      }
      return out;
    }),
    getSymbolRelPaths: vi.fn(
      async (ids: string[]) => new Map(ids.filter((id) => symbolPaths[id]).map((id) => [id, symbolPaths[id]])),
    ),
    close: vi.fn(async () => undefined),
  };
}

/** Hydration chunks keyed on the BARE symbolId — one per (relPath, symbolId) pair. */
function makeQdrant(chunks: { symbolId: string; relativePath: string; startLine: number; endLine: number }[]) {
  return {
    scrollBySymbolIds: vi.fn(async (_c: string, ids: string[]) =>
      chunks
        .filter((c) => ids.includes(c.symbolId))
        .map((c) => ({ id: `${c.relativePath}:${c.symbolId}`, payload: { ...c } })),
    ),
  };
}

function makeOps(graphDb: unknown, qdrant: unknown, reranker: unknown = { rerank: vi.fn() }) {
  return new TracePathOps({
    pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
    qdrant: qdrant as never,
    reranker: reranker as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (n: string) => n,
  });
}

// ui/BaseTable.tsx and admin/BaseTable.tsx both declare a top-level `BaseTable`.
const NAMESAKE_ADJACENCY: ScopedAdjacency = {
  [fileScopedSymbolKey({ relPath: "ui/page.tsx", symbolId: "Page" })]: [["ui/BaseTable.tsx", "BaseTable"]],
  [fileScopedSymbolKey({ relPath: "ui/BaseTable.tsx", symbolId: "BaseTable" })]: [["ui/Cell.tsx", "Cell"]],
  [fileScopedSymbolKey({ relPath: "admin/BaseTable.tsx", symbolId: "BaseTable" })]: [["admin/Footer.tsx", "Footer"]],
};

const NAMESAKE_SYMBOL_PATHS: Record<string, string[]> = {
  Page: ["ui/page.tsx"],
  BaseTable: ["admin/BaseTable.tsx", "ui/BaseTable.tsx"],
  Cell: ["ui/Cell.tsx"],
  Footer: ["admin/Footer.tsx"],
};

const NAMESAKE_CHUNKS = [
  { symbolId: "Page", relativePath: "ui/page.tsx", startLine: 1, endLine: 20 },
  { symbolId: "BaseTable", relativePath: "ui/BaseTable.tsx", startLine: 5, endLine: 50 },
  // Deliberately LAST — the pre-fix hydration map ("last chunk with that
  // symbolId wins") would stamp this path onto every BaseTable step.
  { symbolId: "BaseTable", relativePath: "admin/BaseTable.tsx", startLine: 100, endLine: 140 },
  { symbolId: "Cell", relativePath: "ui/Cell.tsx", startLine: 3, endLine: 9 },
  { symbolId: "Footer", relativePath: "admin/Footer.tsx", startLine: 7, endLine: 11 },
];

describe("TracePathOps — file-scoped dispatch (oxnvl)", () => {
  it("never crosses between namesakes mid-walk", async () => {
    // Page (ui) reaches ui/BaseTable only; Footer hangs off the ADMIN BaseTable.
    // With a bare-symbolId join the two BaseTable nodes merge and a bogus
    // Page -> BaseTable -> Footer path appears.
    const ops = makeOps(makeGraphDb(NAMESAKE_ADJACENCY, NAMESAKE_SYMBOL_PATHS), makeQdrant(NAMESAKE_CHUNKS));

    const res = await ops.tracePath({ collection: "c", from: "Page", to: "Footer" });

    expect(res.paths).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it("lists the candidate files of an ambiguous seed under `namesakes`", async () => {
    const ops = makeOps(makeGraphDb(NAMESAKE_ADJACENCY, NAMESAKE_SYMBOL_PATHS), makeQdrant(NAMESAKE_CHUNKS));

    const res = await ops.tracePath({ collection: "c", from: "BaseTable", to: "Cell" });

    expect(res.namesakes).toEqual({ from: ["admin/BaseTable.tsx", "ui/BaseTable.tsx"], to: ["ui/Cell.tsx"] });
    expect(res.paths).toHaveLength(1);
    expect(res.paths[0].steps.map((s) => s.relativePath)).toEqual(["ui/BaseTable.tsx", "ui/Cell.tsx"]);
  });

  it("omits `namesakes` entirely when both seeds are unambiguous", async () => {
    const ops = makeOps(makeGraphDb(NAMESAKE_ADJACENCY, NAMESAKE_SYMBOL_PATHS), makeQdrant(NAMESAKE_CHUNKS));

    const res = await ops.tracePath({ collection: "c", from: "Page", to: "Cell" });

    expect(res.paths.map((p) => p.steps.map((s) => s.symbolId))).toEqual([["Page", "BaseTable", "Cell"]]);
    expect(res.namesakes).toBeUndefined();
  });

  it("narrows an ambiguous seed to one file via `fromPath`", async () => {
    const ops = makeOps(makeGraphDb(NAMESAKE_ADJACENCY, NAMESAKE_SYMBOL_PATHS), makeQdrant(NAMESAKE_CHUNKS));

    const res = await ops.tracePath({
      collection: "c",
      from: "BaseTable",
      fromPath: "admin/BaseTable.tsx",
      to: "Footer",
    });

    expect(res.paths).toHaveLength(1);
    expect(res.paths[0].steps.map((s) => s.relativePath)).toEqual(["admin/BaseTable.tsx", "admin/Footer.tsx"]);
    // The listing keeps the PRE-filter candidates so the caller sees what was narrowed away.
    expect(res.namesakes?.from).toEqual(["admin/BaseTable.tsx", "ui/BaseTable.tsx"]);
  });

  it("returns no paths plus the namesake listing when `fromPath` matches no candidate", async () => {
    const ops = makeOps(makeGraphDb(NAMESAKE_ADJACENCY, NAMESAKE_SYMBOL_PATHS), makeQdrant(NAMESAKE_CHUNKS));

    const res = await ops.tracePath({ collection: "c", from: "BaseTable", fromPath: "nope/BaseTable.tsx", to: "Cell" });

    expect(res.paths).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(res.namesakes?.from).toEqual(["admin/BaseTable.tsx", "ui/BaseTable.tsx"]);
  });

  it("takes each step's relativePath from the graph node, not from a namesake chunk", async () => {
    const ops = makeOps(makeGraphDb(NAMESAKE_ADJACENCY, NAMESAKE_SYMBOL_PATHS), makeQdrant(NAMESAKE_CHUNKS));

    const res = await ops.tracePath({ collection: "c", from: "Page", to: "Cell" });

    const baseTableStep = res.paths[0].steps[1];
    expect(baseTableStep.relativePath).toBe("ui/BaseTable.tsx");
    // Lines come from the chunk matched on BOTH relPath and symbolId — the
    // admin namesake's 100..140 must not leak in.
    expect(baseTableStep.startLine).toBe(5);
    expect(baseTableStep.endLine).toBe(50);
  });

  it("scores danger per (relPath, symbolId), not per bare symbolId", async () => {
    const reranker = {
      rerank: vi.fn(async (results: { payload?: Record<string, unknown> }[]) =>
        results.map((r) => ({
          ...r,
          // Only the ADMIN namesake is dangerous; the ui one on our path is not.
          score: r.payload?.relativePath === "admin/BaseTable.tsx" ? 0.9 : 0.1,
          rankingOverlay: { preset: "bugHunt", file: { relativePath: r.payload?.relativePath } },
        })),
      ),
    };
    const ops = makeOps(makeGraphDb(NAMESAKE_ADJACENCY, NAMESAKE_SYMBOL_PATHS), makeQdrant(NAMESAKE_CHUNKS), reranker);

    const res = await ops.tracePath({ collection: "c", from: "Page", to: "Cell", rerank: "bugHunt" });

    expect(res.paths[0].aggregateDanger).toBeCloseTo(0.1);
    expect(res.paths[0].steps[1].dangerOverlay).toEqual({
      preset: "bugHunt",
      file: { relativePath: "ui/BaseTable.tsx" },
    });
  });
});

describe("TracePathOps — duplicate call sites over a real graph (oxnvl)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "trace-path-dup-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits ONE path when the same edge is reached from two call sites", async () => {
    await db.upsertFile(
      { relPath: "ui/page.tsx", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "Page",
            targetSymbolId: "Cell",
            targetRelPath: "ui/Cell.tsx",
            callExpression: "Cell",
            edgeKind: "exact",
            confidence: 1,
          },
          {
            sourceSymbolId: "Page",
            targetSymbolId: "Cell",
            targetRelPath: "ui/Cell.tsx",
            callExpression: "this.Cell",
            edgeKind: "exact",
            confidence: 1,
          },
        ],
      },
    );

    const ops = makeOps(
      db,
      makeQdrant([
        { symbolId: "Page", relativePath: "ui/page.tsx", startLine: 1, endLine: 4 },
        { symbolId: "Cell", relativePath: "ui/Cell.tsx", startLine: 1, endLine: 4 },
      ]),
    );

    const res = await ops.tracePath({ collection: "c", from: "Page", to: "Cell" });

    expect(res.paths).toHaveLength(1);
    expect(res.paths[0].steps.map((s) => s.symbolId)).toEqual(["Page", "Cell"]);
  });
});
