/**
 * `GraphDbClient.upsertSymbolsBulk` — batched form of the per-file
 * `upsertSymbols`: one transaction for many files (DELETE-per-file + one
 * `INSERT OR IGNORE` over all rows). Same per-file semantics — within-file
 * duplicate symbolId first-wins, all-or-nothing on failure — just batched
 * across files instead of one BEGIN/COMMIT per file.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DaemonGraphDbClient } from "../../../../src/core/adapters/duckdb/daemon/client.js";
import { decodeFrames, encodeFrame, type DaemonRequest } from "../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { CodegraphDaemonServer } from "../../../../src/core/adapters/duckdb/daemon/server.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import type { SymbolDefinition } from "../../../../src/core/contracts/types/codegraph.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

function mkDef(relPath: string, symbolId: string, fqName: string, shortName: string): SymbolDefinition {
  return {
    relPath,
    symbolId,
    fqName,
    shortName,
    scope: [],
  };
}

describe("DuckDbGraphClient.upsertSymbolsBulk — direct client", () => {
  let refDir: string;
  let sutDir: string;
  let ref: DuckDbGraphClient;
  let sut: DuckDbGraphClient;

  beforeEach(async () => {
    refDir = mkdtempSync(join(tmpdir(), "cg-bulk-ref-"));
    sutDir = mkdtempSync(join(tmpdir(), "cg-bulk-sut-"));
    ref = new DuckDbGraphClient({ path: join(refDir, "g.duckdb") });
    sut = new DuckDbGraphClient({ path: join(sutDir, "g.duckdb") });
    await ref.init();
    await sut.init();
    await runMigrations(ref, DATABASE_MIGRATIONS);
    await runMigrations(sut, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await ref.close();
    await sut.close();
    rmSync(refDir, { recursive: true, force: true });
    rmSync(sutDir, { recursive: true, force: true });
  });

  it("bulk upsert writes the same cg_symbols rows as N per-file upsertSymbols", async () => {
    const defsA = [mkDef("a.ts", "A#m", "A#m", "m")];
    const defsB = [mkDef("b.ts", "B#n", "B#n", "n"), mkDef("b.ts", "B#n", "B#n", "n")]; // dup symbolId
    // reference client: per-file
    await ref.upsertSymbols("a.ts", defsA);
    await ref.upsertSymbols("b.ts", defsB);
    // subject client: one bulk call
    await sut.upsertSymbolsBulk([
      { relPath: "a.ts", definitions: defsA },
      { relPath: "b.ts", definitions: defsB },
    ]);
    const refRows = await ref.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
    const sutRows = await sut.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
    expect(sutRows).toEqual(refRows);
    // within-file dup collapsed to one row (INSERT OR IGNORE, first wins)
    expect(sutRows.filter((r: Record<string, unknown>) => r.rel_path === "b.ts")).toHaveLength(1);
  });

  it("duplicate relPath in one batch is LAST-wins (== two sequential upsertSymbols on that file)", async () => {
    const defOld = mkDef("a.ts", "A#old", "A#old", "old");
    const defNew = mkDef("a.ts", "A#new", "A#new", "new");
    // reference client: two sequential per-file calls — the second DELETE wipes
    // defOld, so only defNew survives.
    await ref.upsertSymbols("a.ts", [defOld]);
    await ref.upsertSymbols("a.ts", [defNew]);
    // subject client: both in ONE bulk batch, same relPath twice.
    await sut.upsertSymbolsBulk([
      { relPath: "a.ts", definitions: [defOld] },
      { relPath: "a.ts", definitions: [defNew] },
    ]);
    const refRows = await ref.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
    const sutRows = await sut.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
    expect(sutRows).toEqual(refRows);
    // Only defNew's row survives for a.ts — defOld was replaced, not unioned.
    expect(sutRows.map((r: Record<string, unknown>) => r.symbol_id)).toEqual(["A#new"]);
  });

  it("bulk upsert is all-or-nothing: a bad row rolls back the whole batch", async () => {
    await sut.upsertSymbols("keep.ts", [mkDef("keep.ts", "K#a", "K#a", "a")]);
    const bad = [
      { relPath: "x.ts", definitions: [mkDef("x.ts", "X#a", "X#a", "a")] },
      {
        relPath: "y.ts",
        definitions: [/* @ts-expect-error missing required SymbolDefinition fields */ { relPath: "y.ts" } as any],
      },
    ];
    await expect(sut.upsertSymbolsBulk(bad)).rejects.toBeTruthy();
    const rows = await sut.queryAll("SELECT rel_path FROM cg_symbols WHERE rel_path IN ('x.ts','y.ts')");
    expect(rows).toHaveLength(0); // neither x nor y landed
    // Unrelated pre-existing data survives the rolled-back batch untouched.
    const kept = await sut.queryAll("SELECT symbol_id FROM cg_symbols WHERE rel_path = 'keep.ts'");
    expect(kept.map((r: Record<string, unknown>) => r.symbol_id)).toEqual(["K#a"]);
  });

  it("empty entries is a no-op", async () => {
    await expect(sut.upsertSymbolsBulk([])).resolves.toBeUndefined();
  });
});

describe("upsertSymbolsBulk — daemon proxy parity", () => {
  let root: string;
  let srv: Server | undefined;
  // Force-destroy any lingering per-connection sockets on teardown so a mid-test
  // assertion failure (before the client reaches `client.close()`) can't leave
  // `srv.close()` waiting forever on an open connection and time out the hook.
  let sockets: Set<Socket>;

  afterEach(async () => {
    for (const s of sockets ?? []) s.destroy();
    await new Promise<void>((res) => {
      if (srv) {
        srv.close(() => {
          res();
        });
      } else {
        res();
      }
    });
    srv = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("upsertSymbolsBulk via the daemon socket writes identical cg_symbols rows to the direct client", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-bulk-daemon-"));
    const pool = new GraphDbClientPool({ rootDir: root, symbolTableFactory: () => new InMemoryGlobalSymbolTable() });
    const server = new CodegraphDaemonServer(pool);
    const socketPath = join(root, "d.sock");

    sockets = new Set();
    srv = createServer((sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const f of frames) {
          const req = JSON.parse(f) as DaemonRequest;
          void server.handle(req).then((res) => sock.write(encodeFrame(res)));
        }
      });
    });
    srv.unref();
    await new Promise<void>((res) => {
      srv?.listen(socketPath, () => {
        res();
      });
    });

    const collection = "code_bulk_daemon_v1";
    const client = new DaemonGraphDbClient(socketPath, collection);
    await client.init();

    const defsA = [mkDef("a.ts", "A#m", "A#m", "m")];
    const defsB = [mkDef("b.ts", "B#n", "B#n", "n"), mkDef("b.ts", "B#n", "B#n", "n")]; // dup symbolId

    await client.upsertSymbolsBulk([
      { relPath: "a.ts", definitions: defsA },
      { relPath: "b.ts", definitions: defsB },
    ]);
    await client.close();

    // Rows written through the daemon, read back via the pool's live handle
    // for this collection (same underlying DuckDB connection the daemon used).
    const { graphDb } = await pool.acquire(collection);
    const daemonRows = await (graphDb as DuckDbGraphClient).queryAll(
      "SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id",
    );
    await pool.closeAll();

    // Direct reference client over its own temp DB, given the exact same entries.
    const refDir = mkdtempSync(join(tmpdir(), "cg-bulk-daemon-ref-"));
    try {
      const refClient = new DuckDbGraphClient({ path: join(refDir, "g.duckdb") });
      await refClient.init();
      await runMigrations(refClient, DATABASE_MIGRATIONS);
      await refClient.upsertSymbolsBulk([
        { relPath: "a.ts", definitions: defsA },
        { relPath: "b.ts", definitions: defsB },
      ]);
      const directRows = await refClient.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
      await refClient.close();
      expect(daemonRows).toEqual(directRows);
    } finally {
      rmSync(refDir, { recursive: true, force: true });
    }
  });
});
