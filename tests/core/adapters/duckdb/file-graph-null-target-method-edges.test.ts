import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

/**
 * bd tea-rags-mcp-rtp6v — the resolver contract allows `targetSymbolId=null`
 * (the file-only edge: the checker proved the FILE but no exported symbol
 * table names the member — the `fetcher.request()` family). The write path
 * used to skip those rows silently: `target_symbol_id` was part of the PK and
 * DuckDB forces PK columns NOT NULL. Migration 026 re-keys the table without
 * target_symbol_id, so the file-only edge persists.
 *
 * What persists is decided HERE, reader by reader:
 *   - `getCallees` surfaces the file-only edge (targetSymbolId=null);
 *   - `getCallers` can never return it (no target symbol to be caller OF);
 *   - graph analytics adjacency (Tarjan/PageRank feed) keeps excluding it;
 *   - the trace_path batch frontier (getCalleeEdges / getCalleeEdgesScoped)
 *     keeps excluding it;
 *   - fan-in of a pinned target is untouched; fan-out of the source counts
 *     the unpinned call.
 */
describe("file-graph writer — file-only method edges persist (rtp6v)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-null-target-edges-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One pinned edge + one file-only edge from the same source symbol. */
  async function seedCallerEdges(): Promise<void> {
    await db.upsertFile(
      { relPath: "src/caller.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          // The file-only edge: file proven, member not in any exported table.
          {
            sourceSymbolId: "Caller#run",
            targetSymbolId: null,
            targetRelPath: "src/only-file.ts",
            callExpression: "fetcher.request()",
          },
          {
            sourceSymbolId: "Caller#run",
            targetSymbolId: "Handler#on",
            targetRelPath: "src/handler.ts",
            callExpression: "handler.on()",
          },
        ],
      },
    );
  }

  it("persists a method edge whose targetSymbolId is null, with its resolved target_rel_path", async () => {
    await seedCallerEdges();

    const rows = await db.queryAll<{
      source_symbol_id: string;
      source_rel_path: string;
      target_symbol_id: string | null;
      target_rel_path: string;
      call_expression: string;
      edge_kind: string | null;
      confidence: number | string | null;
    }>(
      `SELECT source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence
         FROM cg_symbols_edges_method
        ORDER BY target_rel_path`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source_symbol_id: "Caller#run",
      source_rel_path: "src/caller.ts",
      target_symbol_id: "Handler#on",
      target_rel_path: "src/handler.ts",
      call_expression: "handler.on()",
    });
    expect(rows[1]).toMatchObject({
      source_symbol_id: "Caller#run",
      source_rel_path: "src/caller.ts",
      target_symbol_id: null,
      target_rel_path: "src/only-file.ts",
      call_expression: "fetcher.request()",
      edge_kind: "exact",
    });
    expect(Number(rows[1].confidence)).toBe(1);
  });

  it("keeps exactly one file-only row across an identical re-walk (new PK dedups)", async () => {
    await seedCallerEdges();
    await seedCallerEdges();

    const rows = await db.queryAll<{ target_symbol_id: string | null }>(
      "SELECT target_symbol_id FROM cg_symbols_edges_method WHERE call_expression = 'fetcher.request()'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target_symbol_id).toBeNull();
  });

  it("getCallees returns the file-only edge with a null targetSymbolId alongside pinned callees", async () => {
    await seedCallerEdges();

    const callees = await db.getCallees("Caller#run");

    // The pinned callee must keep flowing through beside the null one.
    expect(callees).toHaveLength(2);
    const fileOnly = callees.find((e) => e.targetSymbolId === null);
    expect(fileOnly).toMatchObject({
      targetRelPath: "src/only-file.ts",
      callExpression: "fetcher.request()",
    });
    expect(callees.some((e) => e.targetSymbolId === "Handler#on")).toBe(true);
  });

  it("getCallers never surfaces the file-only edge as anyone's caller row", async () => {
    await seedCallerEdges();

    const callers = await db.getCallers("Handler#on");

    // Only the pinned edge names Handler#on as target; the file-only edge has
    // no target symbol and so is nobody's caller edge.
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatchObject({ sourceSymbolId: "Caller#run", callExpression: "handler.on()" });
  });

  it("graph-analytics adjacency keeps excluding the file-only edge (Tarjan/PageRank feed)", async () => {
    await seedCallerEdges();

    const adjacency = await db.listAdjacency("method");
    expect(adjacency.get("Caller#run")).toEqual(["Handler#on"]);

    const pairs: [string, string, number?][] = [];
    for await (const pair of db.streamAdjacency("method")) pairs.push(pair);
    expect(pairs).toEqual([["Caller#run", "Handler#on", 1]]);
  });

  it("trace_path batch frontier (getCalleeEdges / getCalleeEdgesScoped) keeps excluding the file-only edge", async () => {
    await seedCallerEdges();

    const bare = await db.getCalleeEdges(["Caller#run"]);
    expect(bare.get("Caller#run")).toEqual(["Handler#on"]);

    const scoped = await db.getCalleeEdgesScoped([{ relPath: "src/caller.ts", symbolId: "Caller#run" }]);
    expect(scoped.get("src/caller.ts|Caller#run")).toEqual([{ relPath: "src/handler.ts", symbolId: "Handler#on" }]);
  });

  it("fanIn of the pinned target is untouched; the source's fanOut counts the unpinned call", async () => {
    await seedCallerEdges();

    expect(await db.getCalledByCount("Handler#on")).toBe(1);
    expect(await db.getCallSiteCount("Caller#run")).toBe(2);

    // The bulk projection must agree with the per-symbol getters and must not
    // grow a null-keyed entry from the file-only row.
    const bulk = await db.getChunkSignalsBulk();
    expect(bulk.has(null as unknown as string)).toBe(false);
    expect(bulk.get("Caller#run")).toMatchObject({ fanIn: 0, fanOut: 2 });
    expect(bulk.get("Handler#on")).toMatchObject({ fanIn: 1, fanOut: 0 });
  });
});
