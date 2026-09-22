/**
 * The amh78 repro against a REAL in-process codegraph daemon (bd tea-rags-mcp-amh78).
 *
 * Live, 2026-09-15: index a fixture, query it from an open MCP session (the
 * daemon caches a client), clear the index, index again under the same
 * physical name while the session stays open. The session kept answering from
 * the daemon's cached client, which had been writing into the unlinked file;
 * on disk only `<name>.duckdb.wal` was left, and once the daemon stopped the
 * graph was gone. This drives the same sequence through the socket.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import type { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { getDaemonPaths } from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import { GraphDbClientPool, type GraphDbClientPoolOptions } from "../../../../../src/core/adapters/duckdb/pool.js";
import {
  createDatabaseMigrationApplier,
  DATABASE_MIGRATIONS_MODULE_URL,
} from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const FINGERPRINT = "amh78-daemon";
const NAME = fixturePhysicalCollectionName("code_amh78_daemon_v1");
const NO_EDGES = { fileEdges: [], methodEdges: [] };

let root: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;
const pools: GraphDbClientPool[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.closeAll().catch(() => undefined);
  await stopDaemon?.().catch(() => undefined);
  stopDaemon = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makePool(options: Pick<GraphDbClientPoolOptions, "rootDir"> & Partial<GraphDbClientPoolOptions>) {
  const pool = new GraphDbClientPool({
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    ...options,
  });
  pools.push(pool);
  return pool;
}

describe("codegraph daemon — a collection rebuilt under a name it still holds a client for (amh78)", () => {
  it("keeps the rebuilt graph on disk after the daemon exits", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-amh78-"));
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

    // The MCP / CLI process: every graph op goes through the daemon.
    const session = makePool({
      rootDir: dataRoot,
      daemonSocketPath: paths.socketPath,
      daemonRestart: { buildFingerprint: FINGERPRINT },
    });

    // 1. Index, then read: the daemon opens and caches a client on the collection.
    const indexed = await session.acquireWrite(NAME);
    await indexed.graphDb.upsertFile({ relPath: "before.ts", language: "typescript" }, NO_EDGES);
    expect(await indexed.graphDb.hasData()).toBe(true);

    // 2. clear_index from this process: it holds no in-process client, so it only unlinks.
    await session.removeCollection(NAME);
    expect(existsSync(session.pathFor(NAME))).toBe(false);

    // 3. Index again under the same physical name while the session stays open.
    const reindexed = await session.acquireWrite(NAME);
    await reindexed.graphDb.upsertFile({ relPath: "after.ts", language: "typescript" }, NO_EDGES);

    // 4. The daemon stops.
    await session.closeAll();
    await daemon.shutdown();
    stopDaemon = undefined;

    expect(existsSync(session.pathFor(NAME))).toBe(true);
    const { graphDb } = await makePool({ rootDir: dataRoot }).acquire(NAME);
    const rows = await (graphDb as DuckDbGraphClient).queryAll<{ rel_path: string }>(
      "SELECT rel_path FROM cg_symbols_files ORDER BY rel_path",
    );
    expect(rows.map((row) => row.rel_path)).toEqual(["after.ts"]);
  });
});
