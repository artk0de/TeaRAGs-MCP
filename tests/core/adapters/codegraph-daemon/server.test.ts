import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodegraphDaemonServer } from "../../../../src/core/adapters/codegraph-daemon/server.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let root: string;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

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
});
