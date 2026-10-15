import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DAEMON_OP_COMMANDS } from "../../../../../src/core/adapters/duckdb/daemon/op-commands.js";
import { CodegraphDaemonServer } from "../../../../../src/core/adapters/duckdb/daemon/server.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import type { ResidualCallSiteRow } from "../../../../../src/core/contracts/types/codegraph.js";
import { createDatabaseMigrationApplier } from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function makeServer() {
  root = mkdtempSync(join(tmpdir(), "cg-daemon-residual-"));
  const pool = new GraphDbClientPool({
    rootDir: root,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
  });
  return { server: new CodegraphDaemonServer(pool), pool };
}

const SITE: ResidualCallSiteRow = {
  siteKey: "k1",
  sourceRelPath: "app/billing.rb",
  methodSymbolId: "Billing#run",
  methodStartLine: 10,
  methodEndLine: 20,
  line: 12,
  column: 6,
  receiverText: "account",
  member: "users",
  kind: "dynamic",
  candidates: ["Firm#users"],
  menuHash: "menu-1",
  menuOverflow: false,
};

describe("CodegraphDaemonServer.handle — residual ops", () => {
  it("reads residual sites, applies model edges and marks derived tables stale", async () => {
    const { server, pool } = makeServer();
    const c = "code_residual_v1";

    await server.handle({
      id: 1,
      op: "upsertSymbols",
      params: {
        collection: c,
        relPath: "app/models/firm.rb",
        definitions: [
          {
            symbolId: "Firm#users",
            fqName: "Firm#users",
            shortName: "users",
            relPath: "app/models/firm.rb",
            scope: ["Firm"],
          },
        ],
      },
    });
    await server.handle({
      id: 2,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "app/billing.rb", language: "ruby" },
        edges: { fileEdges: [], methodEdges: [], residualCallSites: [SITE] },
      },
    });

    const sites = await server.handle({
      id: 3,
      op: "readResidualCallSites",
      params: { collection: c },
    });
    const applied = await server.handle({
      id: 4,
      op: "applyModelEdges",
      params: {
        collection: c,
        model: "kev",
        edges: [
          {
            siteKey: "k1",
            sourceRelPath: "app/billing.rb",
            sourceSymbolId: "Billing#run",
            targetSymbolId: "Firm#users",
            model: "kev",
            p: 0.9,
          },
        ],
      },
    });
    const callers = await server.handle({
      id: 5,
      op: "getCallers",
      params: { collection: c, symbolId: "Firm#users" },
    });
    const marked = await server.handle({
      id: 6,
      op: "markDerivedStale",
      params: { collection: c },
    });
    const stale = await server.handle({
      id: 7,
      op: "hasStaleDerivedTables",
      params: { collection: c },
    });

    expect(DAEMON_OP_COMMANDS.readResidualCallSites.access).toBe("read");
    expect(DAEMON_OP_COMMANDS.applyModelEdges.access).toBe("write");
    expect(DAEMON_OP_COMMANDS.markDerivedStale.access).toBe("write");
    expect((sites as { result: unknown }).result).toEqual([SITE]);
    expect(applied.ok).toBe(true);
    expect((applied as { result: unknown }).result).toEqual({ stored: 1, changed: true });
    expect((callers as { result: { sourceSymbolId: string }[] }).result.map((e) => e.sourceSymbolId)).toEqual([
      "Billing#run",
    ]);
    expect(marked.ok).toBe(true);
    expect((stale as { result: unknown }).result).toBe(true);
    await pool.closeAll();
  });
});
