/**
 * `exportSnapshot` over the daemon socket (bd tea-rags-mcp-xi2r9, WTO-7).
 *
 * In daemon mode the daemon holds the one read-write connection to a
 * collection's graph file, so only it can copy that file consistently: rows
 * committed since the last checkpoint sit in a WAL no other process may read.
 * The op is a READ of the collection — the live store is untouched — and a
 * TOLERATED one: a daemon from an older build answers "unknown op", which must
 * surface as a typed refusal the working-tree layer degrades on, never as a
 * reason to drain a daemon other sessions are using.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { DaemonGraphDbClient, LEGACY_TOLERATED_OPS } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { getDaemonPaths } from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import { DAEMON_OP_COMMANDS } from "../../../../../src/core/adapters/duckdb/daemon/op-commands.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { CodegraphSnapshotExportFailedError } from "../../../../../src/core/adapters/duckdb/errors.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import {
  createDatabaseMigrationApplier,
  DATABASE_MIGRATIONS_MODULE_URL,
} from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const FINGERPRINT = "xi2r9-snapshot-daemon";
const NAME = fixturePhysicalCollectionName("code_xi2r9_snapshot_daemon_v1");
const NO_EDGES = { fileEdges: [], methodEdges: [] };

let root: string | undefined;
let srv: Server | undefined;
let stopDaemon: (() => Promise<void>) | undefined;
const pools: GraphDbClientPool[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const pool of pools.splice(0)) await pool.closeAll().catch(() => undefined);
  await stopDaemon?.().catch(() => undefined);
  stopDaemon = undefined;
  const server = srv;
  srv = undefined;
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
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

async function relPathsIn(dbPath: string): Promise<string[]> {
  const reader = new DuckDbGraphClient({ path: dbPath, accessMode: "READ_ONLY" });
  await reader.init();
  try {
    const rows = await reader.queryAll<{ rel_path: string }>("SELECT rel_path FROM cg_symbols_files ORDER BY rel_path");
    return rows.map((r) => r.rel_path);
  } finally {
    await reader.close();
  }
}

describe("exportSnapshot daemon op", () => {
  it("is a tolerated read: a daemon that predates it is refused with the typed error, not drained", async () => {
    expect(LEGACY_TOLERATED_OPS.has("exportSnapshot")).toBe(true);
    expect(DAEMON_OP_COMMANDS.exportSnapshot.access).toBe("read");
    root = mkdtempSync(join(tmpdir(), "cg-snapshot-op-"));
    const socketPath = join(root, "d.sock");
    await fakeDaemon(socketPath, (r) =>
      r.op === "exportSnapshot" ? new Error("unknown daemon op: exportSnapshot") : null,
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const client = new DaemonGraphDbClient(socketPath, fixturePhysicalCollectionName("code_snapshot_legacy_v1"));
    await client.init();
    const err = await client.exportSnapshot(join(root, "snap.duckdb")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodegraphSnapshotExportFailedError);
    expect((err as CodegraphSnapshotExportFailedError).stage).toBe("unsupported");
    await client.close();
  });

  it("round-trips through a real daemon: the snapshot holds the rows the daemon has not checkpointed", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-snapd-"));
    const dataRoot = join(root, "data");
    const paths = getDaemonPaths(join(root, "d"));
    mkdirSync(paths.buildDir, { recursive: true });
    const daemon = await runDaemon({
      rootDir: dataRoot,
      paths,
      buildFingerprint: FINGERPRINT,
      migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
      exit: () => undefined,
    });
    stopDaemon = daemon.shutdown;
    const session = new GraphDbClientPool({
      rootDir: dataRoot,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
      daemonSocketPath: paths.socketPath,
      daemonRestart: { buildFingerprint: FINGERPRINT },
    });
    pools.push(session);
    const { graphDb } = await session.acquireWrite(NAME);
    await graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, NO_EDGES);
    await graphDb.upsertFile({ relPath: "b.ts", language: "typescript" }, NO_EDGES);
    const target = join(root, "wt", "snapshot.duckdb");

    await session.exportSnapshot(NAME, target);

    expect(await relPathsIn(target)).toEqual(["a.ts", "b.ts"]);
    // The daemon still serves the collection afterwards.
    await graphDb.upsertFile({ relPath: "c.ts", language: "typescript" }, NO_EDGES);
    const files = await (graphDb as unknown as DaemonGraphDbClient).listFileContentHashes();
    expect(files.map((f) => f.relPath).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("a daemon-mode pool refuses a collection without a database before asking the daemon", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-snapshot-missing-"));
    const socketPath = join(root, "d.sock");
    const seen: string[] = [];
    await fakeDaemon(socketPath, (r) => {
      seen.push(r.op);
      return null;
    });
    const session = new GraphDbClientPool({
      rootDir: join(root, "data"),
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
      daemonSocketPath: socketPath,
    });
    pools.push(session);

    await expect(session.exportSnapshot(NAME, join(root, "snap.duckdb"))).rejects.toMatchObject({
      code: "INFRA_CODEGRAPH_DATABASE_MISSING",
    });
    expect(seen).not.toContain("exportSnapshot");
  });
});
