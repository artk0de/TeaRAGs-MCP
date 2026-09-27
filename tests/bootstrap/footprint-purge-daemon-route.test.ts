/**
 * `projects unregister --purge` deletes codegraph databases from a process that
 * holds no pool — while the codegraph daemon may still hold a client on them
 * (the purge reports it "left running"). Its codegraph store therefore asks the
 * daemon to remove the file under the daemon pool's path lease, and only acts
 * on the files itself when no daemon of this build is up (bd
 * tea-rags-mcp-r4veq).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPurgeCodegraphStore } from "../../src/bootstrap/footprint-purge.js";
import { DuckDbGraphClient } from "../../src/core/adapters/duckdb/client.js";
import { runDaemon } from "../../src/core/adapters/duckdb/daemon/entry.js";
import { getDaemonPaths, getStorageDir } from "../../src/core/adapters/duckdb/daemon/lifecycle.js";
import { GraphDbClientPool } from "../../src/core/adapters/duckdb/pool.js";
import {
  createDatabaseMigrationApplier,
  DATABASE_MIGRATIONS_MODULE_URL,
} from "../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { fixturePhysicalCollectionName } from "../core/__helpers__/collection-identity.js";

const NAME = fixturePhysicalCollectionName("code_r4veq_purge_v1");
const NO_EDGES = { fileEdges: [], methodEdges: [] };

let root: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;
const pools: GraphDbClientPool[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const pool of pools.splice(0)) await pool.closeAll().catch(() => undefined);
  await stopDaemon?.().catch(() => undefined);
  stopDaemon = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makePool(rootDir: string, daemonSocketPath?: string): GraphDbClientPool {
  const pool = new GraphDbClientPool({
    rootDir,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    daemonSocketPath,
  });
  pools.push(pool);
  return pool;
}

describe("purge codegraph store — routed through the daemon that holds the clients (r4veq)", () => {
  it("waits for the daemon-side op in flight before the database is unlinked", async () => {
    // Short: the socket path is bounded by the 104-byte sun_path on macOS.
    root = mkdtempSync(join(tmpdir(), "r4p-"));
    const appDataDir = join(root, "app");
    // Pinned to scratch so neither side can resolve an ambient daemon directory.
    vi.stubEnv("TEA_RAGS_CODEGRAPH_DAEMON_DIR", join(root, "d"));
    const paths = getDaemonPaths(getStorageDir(appDataDir));
    mkdirSync(paths.buildDir, { recursive: true });
    const daemon = await runDaemon({
      rootDir: appDataDir,
      paths,
      buildFingerprint: "r4veq-purge",
      migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
      exit: () => undefined,
    });
    stopDaemon = daemon.shutdown;
    const session = makePool(appDataDir, paths.socketPath);
    const handle = await session.acquireWrite(NAME);
    await handle.graphDb.upsertFile({ relPath: "old.ts", language: "typescript" }, NO_EDGES);

    let markParked!: () => void;
    const parked = new Promise<void>((resolve) => (markParked = resolve));
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    const real = DuckDbGraphClient.prototype.upsertFile;
    vi.spyOn(DuckDbGraphClient.prototype, "upsertFile").mockImplementation(async function (
      this: DuckDbGraphClient,
      ...args: Parameters<DuckDbGraphClient["upsertFile"]>
    ) {
      if (args[0].relPath === "ghost.ts") {
        markParked();
        await gate;
      }
      return real.apply(this, args);
    });

    const events: string[] = [];
    const ghostWrite = handle.graphDb
      .upsertFile({ relPath: "ghost.ts", language: "typescript" }, NO_EDGES)
      .then(() => events.push("ghost:done"));
    await parked;

    const removal = createPurgeCodegraphStore(appDataDir)
      .removeCollection(NAME)
      .then(() => events.push("purge:done"));
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual([]);
    expect(existsSync(session.pathFor(NAME))).toBe(true);

    resume();
    await ghostWrite;
    await removal;
    expect(events).toEqual(["ghost:done", "purge:done"]);
    expect(existsSync(session.pathFor(NAME))).toBe(false);
  });

  it("with no daemon up, removes the files itself", async () => {
    root = mkdtempSync(join(tmpdir(), "r4p-"));
    const appDataDir = join(root, "app");
    // Pinned to scratch so neither side can resolve an ambient daemon directory.
    vi.stubEnv("TEA_RAGS_CODEGRAPH_DAEMON_DIR", join(root, "d"));
    const direct = makePool(appDataDir);
    await direct.acquire(NAME);
    await direct.closeAll();

    await createPurgeCodegraphStore(appDataDir).removeCollection(NAME);

    expect(existsSync(direct.pathFor(NAME))).toBe(false);
  });
});
