/**
 * `compactStorage` over the daemon socket (bd tea-rags-mcp-dvzdm).
 *
 * The daemon owns the one read-write connection to a collection's graph file,
 * so the compaction runs there, admitted in write order like any other write.
 * It is a TOLERATED op: a daemon from an older build answers "unknown op", and
 * that must read as "not compacted" — never as a reason to drain a daemon other
 * sessions are using.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import type { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { DaemonGraphDbClient, LEGACY_TOLERATED_OPS } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { CodegraphDaemonServer } from "../../../../../src/core/adapters/duckdb/daemon/server.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { createDatabaseMigrationApplier } from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let dir: string | undefined;
let srv: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
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
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function fakeDaemon(socketPath: string, onReq: (r: DaemonRequest) => unknown): Promise<void> {
  srv = createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        const req = JSON.parse(f) as DaemonRequest;
        const out = onReq(req);
        sock.write(
          encodeFrame(
            out instanceof Error
              ? { id: req.id, ok: false, error: { name: out.name, message: out.message } }
              : { id: req.id, ok: true, result: out },
          ),
        );
      }
    });
  });
  srv.unref();
  const server = srv;
  return new Promise((res) => {
    server.listen(socketPath, () => {
      res();
    });
  });
}

describe("compactStorage daemon op", () => {
  it("is tolerated: a daemon that predates it answers 'not compacted'", async () => {
    expect(LEGACY_TOLERATED_OPS.has("compactStorage")).toBe(true);
    dir = mkdtempSync(join(tmpdir(), "cg-compact-op-"));
    const socketPath = join(dir, "d.sock");
    await fakeDaemon(socketPath, (r) =>
      r.op === "compactStorage" ? new Error("unknown daemon op: compactStorage") : null,
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const client = new DaemonGraphDbClient(socketPath, "code_compact_legacy_v1");
    await client.init();
    await expect(client.compactStorage()).resolves.toEqual({ kind: "skipped", reason: "unsupported" });
    await client.close();
  });

  it("the server runs it as a write on the pooled collection and returns the outcome", async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-compact-op-db-"));
    const pool = new GraphDbClientPool({
      rootDir: dir,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
      compactionPolicy: { minFileBytes: 0, minStoredToLiveRatio: 2 },
    });
    const server = new CodegraphDaemonServer(pool, "fp-test");
    const collection = fixturePhysicalCollectionName("code_compact_op_v1");
    try {
      const { graphDb } = await pool.acquire(collection);
      const db = graphDb as DuckDbGraphClient;
      for (let run = 0; run < 4; run++) {
        await db.run("DELETE FROM cg_symbols_files");
        for (let f = 0; f < 20; f++) {
          await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, 'go')", [`f${f}.go`]);
        }
        await db.checkpoint();
      }

      const res = await server.handle({ id: 7, op: "compactStorage", params: { collection } });

      expect(res.ok).toBe(true);
      expect((res as { result: { kind: string } }).result.kind).toBe("compacted");
      const again = await server.handle({ id: 8, op: "compactStorage", params: { collection } });
      expect((again as { result: unknown }).result).toMatchObject({ kind: "skipped", reason: "belowThreshold" });
    } finally {
      await pool.closeAll();
    }
  });
});
