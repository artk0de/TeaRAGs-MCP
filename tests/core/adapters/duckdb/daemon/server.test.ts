import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodegraphDaemonServer } from "../../../../../src/core/adapters/duckdb/daemon/server.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function makeServer() {
  root = mkdtempSync(join(tmpdir(), "cg-daemon-"));
  const pool = new GraphDbClientPool({ rootDir: root, symbolTableFactory: () => new InMemoryGlobalSymbolTable() });
  return { server: new CodegraphDaemonServer(pool), pool };
}

describe("CodegraphDaemonServer.handle", () => {
  it("upsertFile then computeAndPersistCyclesAndSignals persists with no throw", async () => {
    const { server, pool } = makeServer();
    const c = "code_test_v1";
    expect((await server.handle({ id: 1, op: "handshake", params: { collection: c } })).ok).toBe(true);
    const up = await server.handle({
      id: 2,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "a.ts", language: "typescript" },
        edges: { fileEdges: [], methodEdges: [] },
      },
    });
    expect(up.ok).toBe(true);
    const an = await server.handle({ id: 3, op: "computeAndPersistCyclesAndSignals", params: { collection: c } });
    expect(an.ok).toBe(true);
    const { graphDb } = await pool.acquire(c);
    expect(await graphDb.hasData()).toBe(true);
    await pool.closeAll();
  });

  it("returns ok:false with typed error name on a failing op", async () => {
    const { server, pool } = makeServer();
    // unknown op → error response, not a throw
    const res = await server.handle({ id: 9, op: "bogus" as never, params: { collection: "c" } });
    expect(res.ok).toBe(false);
    await pool.closeAll();
  });

  it("computeAndPersistCyclesAndSignals traverses populated adjacency (file + method edges)", async () => {
    const { server, pool } = makeServer();
    const c = "code_adj_v1";
    // Two files with a file-import edge AND a method-call edge so the
    // daemon-side analysis walks non-empty adjacency for both scopes.
    await server.handle({
      id: 1,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "a.ts", language: "typescript" },
        edges: {
          fileEdges: [{ targetRelPath: "b.ts", importText: "./b" }],
          methodEdges: [
            {
              sourceSymbolId: "A#run",
              targetSymbolId: "B#help",
              targetRelPath: "b.ts",
              callExpression: "this.b.help()",
            },
          ],
        },
      },
    });
    await server.handle({
      id: 2,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "b.ts", language: "typescript" },
        edges: { fileEdges: [], methodEdges: [] },
      },
    });
    const an = await server.handle({
      id: 3,
      op: "computeAndPersistCyclesAndSignals",
      params: { collection: c },
    });
    expect(an.ok).toBe(true);
    await pool.closeAll();
  });

  it("findCycles op forwards pathPattern so the daemon scopes the result by file path", async () => {
    const { server, pool } = makeServer();
    const c = "code_cyc_v1";
    // Two independent file-import cycles in distinct scopes: one under
    // domains/ingest/, one under domains/explore/.
    const importCycle = async (a: string, b: string): Promise<void> => {
      await server.handle({
        id: 1,
        op: "upsertFile",
        params: {
          collection: c,
          node: { relPath: a, language: "typescript" },
          edges: { fileEdges: [{ targetRelPath: b, importText: "./x" }], methodEdges: [] },
        },
      });
      await server.handle({
        id: 2,
        op: "upsertFile",
        params: {
          collection: c,
          node: { relPath: b, language: "typescript" },
          edges: { fileEdges: [{ targetRelPath: a, importText: "./x" }], methodEdges: [] },
        },
      });
    };
    await importCycle("src/core/domains/ingest/a.ts", "src/core/domains/ingest/b.ts");
    await importCycle("src/core/domains/explore/x.ts", "src/core/domains/explore/y.ts");
    await server.handle({ id: 3, op: "computeAndPersistCyclesAndSignals", params: { collection: c } });

    const all = await server.handle({ id: 4, op: "findCycles", params: { collection: c, scope: "file" } });
    expect(all.ok).toBe(true);
    expect((all as { result: unknown[] }).result).toHaveLength(2);

    const scoped = await server.handle({
      id: 5,
      op: "findCycles",
      params: { collection: c, scope: "file", pathPattern: "**/domains/ingest/**" },
    });
    expect(scoped.ok).toBe(true);
    const cycles = (scoped as { result: { members: string[] }[] }).result;
    expect(cycles).toHaveLength(1);
    expect(cycles[0].members.slice().sort()).toEqual(["src/core/domains/ingest/a.ts", "src/core/domains/ingest/b.ts"]);
    await pool.closeAll();
  });

  it("removeSymbolsForFile and checkpoint dispatch to the pooled graphDb without throwing", async () => {
    const { server, pool } = makeServer();
    const c = "code_ops_v1";
    // Seed a file, then remove its symbols and checkpoint — both are
    // write ops that route through pool.acquire(collection).
    await server.handle({
      id: 1,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "a.ts", language: "typescript" },
        edges: { fileEdges: [], methodEdges: [] },
      },
    });
    const removed = await server.handle({
      id: 2,
      op: "removeSymbolsForFile",
      params: { collection: c, relPath: "a.ts" },
    });
    const checkpointed = await server.handle({ id: 3, op: "checkpoint", params: { collection: c } });
    expect(removed.ok).toBe(true);
    expect(checkpointed.ok).toBe(true);
    await pool.closeAll();
  });

  it("getCallers read op returns the caller edge array after an upsert that creates a caller relationship", async () => {
    const { server, pool } = makeServer();
    const c = "code_reads_v1";
    // a.ts: A#run calls B#help in b.ts → b's B#help has a caller A#run.
    await server.handle({
      id: 1,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "a.ts", language: "typescript" },
        edges: {
          fileEdges: [],
          methodEdges: [
            {
              sourceSymbolId: "A#run",
              targetSymbolId: "B#help",
              targetRelPath: "b.ts",
              callExpression: "this.b.help()",
            },
          ],
        },
      },
    });
    await server.handle({
      id: 2,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "b.ts", language: "typescript" },
        edges: { fileEdges: [], methodEdges: [] },
      },
    });
    const res = await server.handle({
      id: 3,
      op: "getCallers",
      params: { collection: c, symbolId: "B#help" },
    });
    expect(res.ok).toBe(true);
    expect(Array.isArray((res as { result: unknown }).result)).toBe(true);
    const callers = (res as { result: { sourceSymbolId: string }[] }).result;
    expect(callers.map((e) => e.sourceSymbolId)).toContain("A#run");
    await pool.closeAll();
  });

  it("getCallees / findCycles read ops return clean empty arrays on an empty graph", async () => {
    const { server, pool } = makeServer();
    const c = "code_reads_empty_v1";
    await server.handle({ id: 1, op: "handshake", params: { collection: c } });
    const callees = await server.handle({
      id: 2,
      op: "getCallees",
      params: { collection: c, symbolId: "Nope#missing" },
    });
    const cycles = await server.handle({
      id: 3,
      op: "findCycles",
      params: { collection: c, scope: "file" },
    });
    expect(callees.ok).toBe(true);
    expect((callees as { result: unknown[] }).result).toEqual([]);
    expect(cycles.ok).toBe(true);
    expect((cycles as { result: unknown[] }).result).toEqual([]);
    await pool.closeAll();
  });

  it("dispatches the full proxied surface (reads + writes) against the pooled graphDb without throwing", async () => {
    const { server, pool } = makeServer();
    const c = "code_full_v1";
    // a.ts imports b.ts and A#run calls B#help — gives both a file edge and a
    // method edge so the fan/impact/pagerank reads have real data to return.
    await server.handle({
      id: 1,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "a.ts", language: "typescript" },
        edges: {
          fileEdges: [{ targetRelPath: "b.ts", importText: "./b" }],
          methodEdges: [
            {
              sourceSymbolId: "A#run",
              targetSymbolId: "B#help",
              targetRelPath: "b.ts",
              callExpression: "this.b.help()",
            },
          ],
        },
      },
    });
    await server.handle({
      id: 2,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "b.ts", language: "typescript" },
        edges: { fileEdges: [], methodEdges: [] },
      },
    });

    // Persist symbols so listAllSymbols returns rows.
    const sym = await server.handle({
      id: 3,
      op: "upsertSymbols",
      params: {
        collection: c,
        relPath: "a.ts",
        definitions: [{ symbolId: "A#run", fqName: "A.run", shortName: "run", relPath: "a.ts", scope: [] }],
      },
    });
    expect(sym.ok).toBe(true);

    // Run analysis daemon-side, then persist cycles + ranks directly.
    expect(
      (await server.handle({ id: 4, op: "computeAndPersistCyclesAndSignals", params: { collection: c } })).ok,
    ).toBe(true);
    expect(
      (await server.handle({ id: 5, op: "replaceCycles", params: { collection: c, scope: "file", sccs: [] } })).ok,
    ).toBe(true);
    expect(
      (await server.handle({ id: 6, op: "replacePageRanks", params: { collection: c, ranks: [["A#run", 0.5]] } })).ok,
    ).toBe(true);

    // Reads.
    const fanIn = await server.handle({ id: 7, op: "getFanIn", params: { collection: c, relPath: "b.ts" } });
    expect(fanIn.ok).toBe(true);
    expect((fanIn as { result: number }).result).toBe(1); // b imported by a

    const fanOut = await server.handle({ id: 8, op: "getFanOut", params: { collection: c, relPath: "a.ts" } });
    expect((fanOut as { result: number }).result).toBe(1); // a imports b

    expect(
      (await server.handle({ id: 9, op: "getCalledByCount", params: { collection: c, symbolId: "B#help" } })).ok,
    ).toBe(true);
    expect(
      (await server.handle({ id: 10, op: "getCallSiteCount", params: { collection: c, symbolId: "A#run" } })).ok,
    ).toBe(true);
    expect((await server.handle({ id: 11, op: "hasData", params: { collection: c } })).result).toBe(true);

    const all = await server.handle({ id: 12, op: "listAllSymbols", params: { collection: c } });
    expect((all as { result: { symbolId: string }[] }).result.map((s) => s.symbolId)).toContain("A#run");

    const impact = await server.handle({
      id: 13,
      op: "getTransitiveImpact",
      params: { collection: c, relPath: "b.ts", maxDepth: 3 },
    });
    expect(impact.ok).toBe(true);

    const adj = await server.handle({ id: 14, op: "listAdjacency", params: { collection: c, scope: "file" } });
    expect(adj.ok).toBe(true);
    // Serialised as entries — a.ts → [b.ts].
    expect((adj as { result: [string, string[]][] }).result).toEqual([["a.ts", ["b.ts"]]]);

    const rank = await server.handle({ id: 15, op: "getPageRank", params: { collection: c, symbolId: "A#run" } });
    expect(rank.ok).toBe(true);

    // removeFile.
    expect((await server.handle({ id: 16, op: "removeFile", params: { collection: c, relPath: "a.ts" } })).ok).toBe(
      true,
    );

    await pool.closeAll();
  });

  it("recordRunStats then getRunStats round-trips the per-receiver-kind breakdown (bd j431)", async () => {
    const { server, pool } = makeServer();
    const c = "code_runstats_v1";
    await server.handle({ id: 1, op: "handshake", params: { collection: c } });
    const rec = await server.handle({
      id: 2,
      op: "recordRunStats",
      params: {
        collection: c,
        rows: [
          {
            language: "typescript",
            receiverKind: "constant",
            attempted: 100,
            resolved: 90,
            externalSkipped: 7,
            unresolvable: 0,
          },
          {
            language: "ruby",
            receiverKind: "bareCall",
            attempted: 50,
            resolved: 10,
            externalSkipped: 0,
            unresolvable: 3,
          },
        ],
      },
    });
    expect(rec.ok).toBe(true);
    const got = await server.handle({ id: 3, op: "getRunStats", params: { collection: c } });
    expect(got.ok).toBe(true);
    // ORDER BY language, receiver_kind → ruby/bareCall before typescript/constant.
    expect((got as { result: unknown }).result).toEqual([
      { language: "ruby", receiverKind: "bareCall", attempted: 50, resolved: 10, externalSkipped: 0, unresolvable: 3 },
      {
        language: "typescript",
        receiverKind: "constant",
        attempted: 100,
        resolved: 90,
        externalSkipped: 7,
        unresolvable: 0,
      },
    ]);
    await pool.closeAll();
  });

  it("dispatches getCalleeEdges and serialises the Map as entries", async () => {
    const { server, pool } = makeServer();
    const c = "code_callee_edges_v1";
    // a.ts: A#run calls B#help (b.ts) AND C#aid (c.ts) — A has two callee edges.
    // The Task-3 SQL ORDERs BY source_symbol_id, target_symbol_id, so for source
    // "A#run" the targets come back sorted: B#help < C#aid.
    await server.handle({
      id: 1,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "a.ts", language: "typescript" },
        edges: {
          fileEdges: [],
          methodEdges: [
            {
              sourceSymbolId: "A#run",
              targetSymbolId: "B#help",
              targetRelPath: "b.ts",
              callExpression: "this.b.help()",
            },
            { sourceSymbolId: "A#run", targetSymbolId: "C#aid", targetRelPath: "c.ts", callExpression: "this.c.aid()" },
          ],
        },
      },
    });
    const res = await server.handle({ id: 2, op: "getCalleeEdges", params: { collection: c, symbolIds: ["A#run"] } });
    expect(res.ok).toBe(true);
    // Map serialises as [key, value][] entries over the wire; targets sorted by SQL.
    expect((res as { result: [string, string[]][] }).result).toEqual([["A#run", ["B#help", "C#aid"]]]);
    await pool.closeAll();
  });

  it("updateSymbolChunkIds dispatches the write op and returns null", async () => {
    const { server, pool } = makeServer();
    const c = "code_chunk_ids_v1";
    await server.handle({
      id: 1,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "x.ts", language: "typescript" },
        edges: { fileEdges: [], methodEdges: [] },
      },
    });
    await server.handle({
      id: 2,
      op: "upsertSymbols",
      params: {
        collection: c,
        relPath: "x.ts",
        definitions: [{ symbolId: "X#run", fqName: "X.run", shortName: "run", relPath: "x.ts", scope: [] }],
      },
    });
    const res = await server.handle({
      id: 3,
      op: "updateSymbolChunkIds",
      params: { collection: c, relPath: "x.ts", chunkIds: [["X#run", "chunk_42"]] },
    });
    expect(res.ok).toBe(true);
    expect((res as { result: null }).result).toBeNull();
    await pool.closeAll();
  });

  it("findSymbolChunk read op returns the stored SymbolChunkLocation", async () => {
    const { server, pool } = makeServer();
    const c = "code_find_chunk_v1";
    await server.handle({
      id: 1,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "x.ts", language: "typescript" },
        edges: { fileEdges: [], methodEdges: [] },
      },
    });
    await server.handle({
      id: 2,
      op: "upsertSymbols",
      params: {
        collection: c,
        relPath: "x.ts",
        definitions: [{ symbolId: "X#run", fqName: "X.run", shortName: "run", relPath: "x.ts", scope: [] }],
      },
    });
    await server.handle({
      id: 3,
      op: "updateSymbolChunkIds",
      params: { collection: c, relPath: "x.ts", chunkIds: [["X#run", "chunk_42"]] },
    });
    const res = await server.handle({
      id: 4,
      op: "findSymbolChunk",
      params: { collection: c, symbolId: "X#run" },
    });
    expect(res.ok).toBe(true);
    expect((res as { result: { relPath: string; chunkId: string } }).result).toEqual({
      relPath: "x.ts",
      chunkId: "chunk_42",
    });
    await pool.closeAll();
  });

  it("finalizeReindex deletes the old version DB file, new version readable", async () => {
    const { server, pool } = makeServer();
    await server.handle({
      id: 1,
      op: "upsertFile",
      params: {
        collection: "code_x_v1",
        node: { relPath: "a.ts", language: "typescript" },
        edges: { fileEdges: [], methodEdges: [] },
      },
    });
    await server.handle({
      id: 2,
      op: "upsertFile",
      params: {
        collection: "code_x_v2",
        node: { relPath: "a.ts", language: "typescript" },
        edges: { fileEdges: [], methodEdges: [] },
      },
    });
    const oldPath = pool.pathFor("code_x_v1");
    expect(existsSync(oldPath)).toBe(true);
    const res = await server.handle({
      id: 3,
      op: "finalizeReindex",
      params: { collection: "code_x_v2", oldVersion: "code_x_v1", newVersion: "code_x_v2" },
    });
    expect(res.ok).toBe(true);
    expect(existsSync(oldPath)).toBe(false); // old deleted
    const ro = await pool.acquireRead("code_x_v2");
    expect(await ro.graphDb.hasData()).toBe(true); // new live
    await ro.graphDb.close();
    await pool.closeAll();
  });
});
