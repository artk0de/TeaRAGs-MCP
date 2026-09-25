/**
 * The temporal co-change ops through the daemon, which holds the only
 * connection (bd tea-rags-mcp-x4rpp): the builder writes through
 * `replaceTemporalCochange` and compares HEAD through `readTemporalCochangeMeta`;
 * `get_architecture_report` reads `readTemporalCochangeGraph` (bd tea-rags-mcp-b4dcz).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DAEMON_OP_COMMANDS } from "../../../../../src/core/adapters/duckdb/daemon/op-commands.js";
import { CodegraphDaemonServer } from "../../../../../src/core/adapters/duckdb/daemon/server.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import type { TemporalCochangeSnapshot } from "../../../../../src/core/contracts/types/codegraph.js";
import { createDatabaseMigrationApplier } from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function makeServer() {
  root = mkdtempSync(join(tmpdir(), "cg-daemon-temporal-"));
  const pool = new GraphDbClientPool({
    rootDir: root,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
  });
  return { server: new CodegraphDaemonServer(pool), pool };
}

const SNAPSHOT: TemporalCochangeSnapshot = {
  meta: {
    head: "h1",
    fingerprint: "fp",
    builtAt: 100,
    windowSince: 0,
    commitCount: 3,
    bundleCount: 3,
    admittedBundleCount: 3,
    maxFilesPerBundle: 4,
    minSupport: 2,
    maxPartnersPerFile: 20,
    sessionGapMinutes: 30,
  },
  files: [
    { relPath: "a.ts", bundleCount: 3, partnerCount: 1, lastChangedAt: 90 },
    { relPath: "b.yml", bundleCount: 2, partnerCount: 1, lastChangedAt: 90 },
  ],
  edges: [
    {
      relPathA: "a.ts",
      relPathB: "b.yml",
      support: 2,
      confidenceAB: 2 / 3,
      confidenceBA: 1,
      lift: 1,
      lastCoChangeAt: 90,
      sampleCommits: ["s2", "s1"],
    },
  ],
};

describe("CodegraphDaemonServer.handle — temporal co-change ops", () => {
  it("writes a build and answers its meta and graph", async () => {
    const { server, pool } = makeServer();
    const c = "code_temporal_v1";

    const write = await server.handle({
      id: 1,
      op: "replaceTemporalCochange",
      params: { collection: c, snapshot: SNAPSHOT },
    });
    const meta = await server.handle({ id: 2, op: "readTemporalCochangeMeta", params: { collection: c } });
    const graph = await server.handle({ id: 3, op: "readTemporalCochangeGraph", params: { collection: c } });

    expect(DAEMON_OP_COMMANDS.replaceTemporalCochange.access).toBe("write");
    expect(DAEMON_OP_COMMANDS.readTemporalCochangeMeta.access).toBe("read");
    expect(DAEMON_OP_COMMANDS.readTemporalCochangeGraph.access).toBe("read");
    expect(write.ok).toBe(true);
    expect((meta as { result: unknown }).result).toEqual(SNAPSHOT.meta);
    expect((graph as { result: unknown }).result).toEqual({
      meta: SNAPSHOT.meta,
      edges: [{ ...SNAPSHOT.edges[0], structurallyLinked: false }],
    });
    await pool.closeAll();
  });
});
