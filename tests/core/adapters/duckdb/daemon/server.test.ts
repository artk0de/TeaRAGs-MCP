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
