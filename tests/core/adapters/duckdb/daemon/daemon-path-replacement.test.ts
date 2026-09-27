/**
 * Daemon mode: a path replacer runs where the clients are (bd tea-rags-mcp-r4veq).
 *
 * In the default write path the MCP / CLI process holds no in-process client —
 * the codegraph daemon does. A clear, a delete, an orphan sweep or a footprint
 * clone that unlinks or publishes the file from the app process therefore
 * replaced it under the daemon's clients, and a daemon-side op already running
 * on the old client kept writing: DuckDB addresses the WAL by path, so its rows
 * replayed into the successor. These tests drive the replacement through the
 * daemon's own `GraphDbClientPool`, whose path lease drains the op first, and
 * pin the fallbacks for a daemon that is not running or predates the ops.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { DaemonGraphDbClient, LEGACY_TOLERATED_OPS } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import {
  daemonPathsForKeyDir,
  getDaemonPaths,
  type CodegraphDaemonPaths,
} from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { GraphDbClientPool, type GraphDbClientPoolOptions } from "../../../../../src/core/adapters/duckdb/pool.js";
import type { GraphDbClient } from "../../../../../src/core/contracts/types/codegraph.js";
import {
  createDatabaseMigrationApplier,
  DATABASE_MIGRATIONS_MODULE_URL,
} from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const FINGERPRINT = "r4veq-daemon";
const SOURCE = fixturePhysicalCollectionName("code_r4veq_daemon_source_v1");
const TARGET = fixturePhysicalCollectionName("code_r4veq_daemon_target_v1");
const NO_EDGES = { fileEdges: [], methodEdges: [] };

let root: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;
let fake: Server | undefined;
const pools: GraphDbClientPool[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const pool of pools.splice(0)) await pool.closeAll().catch(() => undefined);
  await stopDaemon?.().catch(() => undefined);
  stopDaemon = undefined;
  const server = fake;
  fake = undefined;
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

function makePool(options: Pick<GraphDbClientPoolOptions, "rootDir"> & Partial<GraphDbClientPoolOptions>) {
  const pool = new GraphDbClientPool({
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    ...options,
  });
  pools.push(pool);
  return pool;
}

interface DaemonFixture {
  dataRoot: string;
  paths: CodegraphDaemonPaths;
  /** The MCP / CLI process: every graph op goes through the daemon. */
  session: GraphDbClientPool;
}

async function startDaemon(): Promise<DaemonFixture> {
  root = mkdtempSync(join(tmpdir(), "cg-r4veq-"));
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
  const session = makePool({
    rootDir: dataRoot,
    daemonSocketPath: paths.socketPath,
    daemonRestart: { buildFingerprint: FINGERPRINT },
  });
  return { dataRoot, paths, session };
}

/**
 * Park the daemon-side `upsertFile` of `relPath` BEFORE it writes, so the op is
 * in flight on the daemon's client while a replacer runs.
 */
function parkDaemonWrite(relPath: string): { parked: Promise<void>; resume: () => void } {
  let markParked!: () => void;
  const parked = new Promise<void>((resolve) => (markParked = resolve));
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => (resume = resolve));
  const real = DuckDbGraphClient.prototype.upsertFile;
  vi.spyOn(DuckDbGraphClient.prototype, "upsertFile").mockImplementation(async function (
    this: DuckDbGraphClient,
    ...args: Parameters<DuckDbGraphClient["upsertFile"]>
  ) {
    if (args[0].relPath === relPath) {
      markParked();
      await gate;
    }
    return real.apply(this, args);
  });
  return { parked, resume };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

async function relPathsThrough(graphDb: GraphDbClient): Promise<string[]> {
  const files = await (graphDb as unknown as DaemonGraphDbClient).listFileContentHashes();
  return files.map((file) => file.relPath).sort();
}

/** What the next process sees once the daemon is gone. */
async function relPathsOnDisk(dataRoot: string, name: typeof TARGET): Promise<string[]> {
  const { graphDb } = await makePool({ rootDir: dataRoot }).acquire(name);
  const rows = await (graphDb as DuckDbGraphClient).queryAll<{ rel_path: string }>(
    "SELECT rel_path FROM cg_symbols_files ORDER BY rel_path",
  );
  return rows.map((row) => row.rel_path);
}

describe("daemon mode — path replacers drain the daemon's client (r4veq)", () => {
  it("a clone over a target the daemon is writing never carries the old client's rows into the successor (ghost-row probe)", async () => {
    const { dataRoot, session } = await startDaemon();
    const source = await session.acquireWrite(SOURCE);
    await source.graphDb.upsertFile({ relPath: "cloned.ts", language: "typescript" }, NO_EDGES);
    await source.graphDb.checkpoint();
    const target = await session.acquireWrite(TARGET);
    await target.graphDb.upsertFile({ relPath: "old.ts", language: "typescript" }, NO_EDGES);
    // No WAL open on the old client: the ghost's write creates `<target>.wal` by path.
    await target.graphDb.checkpoint();

    const ghost = parkDaemonWrite("ghost.ts");
    const ghostWrite = target.graphDb.upsertFile({ relPath: "ghost.ts", language: "typescript" }, NO_EDGES);
    await ghost.parked;

    const events: string[] = [];
    const clone = session.cloneDatabase(SOURCE, TARGET).then(() => events.push("clone:done"));
    await settle();
    ghost.resume();
    await ghostWrite.then(() => events.push("ghost:done"));
    await clone;

    // The successor holds the source's rows and NOTHING the old client wrote.
    const successor = await session.acquireWrite(TARGET);
    expect(await relPathsThrough(successor.graphDb)).toEqual(["cloned.ts"]);
    await session.closeAll();
    await stopDaemon?.();
    stopDaemon = undefined;
    expect(await relPathsOnDisk(dataRoot, TARGET)).toEqual(["cloned.ts"]);
    // And the op finished on the old client before the successor was published.
    expect(events).toEqual(["ghost:done", "clone:done"]);
  });

  it("removeCollection waits for the daemon-side op in flight, then unlinks", async () => {
    const { session } = await startDaemon();
    const target = await session.acquireWrite(TARGET);
    await target.graphDb.upsertFile({ relPath: "old.ts", language: "typescript" }, NO_EDGES);

    const ghost = parkDaemonWrite("ghost.ts");
    const events: string[] = [];
    const ghostWrite = target.graphDb
      .upsertFile({ relPath: "ghost.ts", language: "typescript" }, NO_EDGES)
      .then(() => events.push("ghost:done"));
    await ghost.parked;

    const removal = session.removeCollection(TARGET).then(() => events.push("remove:done"));
    await settle();
    expect(events).toEqual([]);
    expect(existsSync(session.pathFor(TARGET))).toBe(true);

    ghost.resume();
    await ghostWrite;
    await removal;
    expect(events).toEqual(["ghost:done", "remove:done"]);
    expect(existsSync(session.pathFor(TARGET))).toBe(false);

    // The next write opens the path afresh.
    const fresh = await session.acquireWrite(TARGET);
    await fresh.graphDb.upsertFile({ relPath: "after.ts", language: "typescript" }, NO_EDGES);
    expect(await relPathsThrough(fresh.graphDb)).toEqual(["after.ts"]);
  });

  it("with no daemon running, replacers act in-process without connecting", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-r4veq-nodaemon-"));
    const dataRoot = join(root, "data");
    const paths = getDaemonPaths(join(root, "d"));
    const direct = makePool({ rootDir: dataRoot });
    const seed = await direct.acquire(SOURCE);
    await seed.graphDb.upsertFile({ relPath: "cloned.ts", language: "typescript" }, NO_EDGES);
    await direct.closeAll();

    const connects = vi.spyOn(DaemonGraphDbClient.prototype, "init");
    const session = makePool({ rootDir: dataRoot, daemonSocketPath: paths.socketPath });
    await session.cloneDatabase(SOURCE, TARGET);
    expect(await relPathsOnDisk(dataRoot, TARGET)).toEqual(["cloned.ts"]);
    await pools.at(-1)?.closeAll();
    await session.removeCollection(TARGET);

    expect(existsSync(session.pathFor(TARGET))).toBe(false);
    expect(connects).not.toHaveBeenCalled();
  });

  it("a daemon that predates the ops is tolerated: the replacer falls back to the in-process path", async () => {
    expect(LEGACY_TOLERATED_OPS.has("removeCollectionDatabase")).toBe(true);
    expect(LEGACY_TOLERATED_OPS.has("cloneCollectionDatabase")).toBe(true);

    root = mkdtempSync(join(tmpdir(), "cg-r4veq-legacy-"));
    const dataRoot = join(root, "data");
    const paths = daemonPathsForKeyDir(join(root, "k"));
    mkdirSync(paths.buildDir, { recursive: true });
    // A live daemon (this process's pid) whose dispatcher knows neither op.
    writeFileSync(paths.pidFile, String(process.pid));
    const seen: string[] = [];
    fake = createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const frame of frames) {
          const req = JSON.parse(frame) as DaemonRequest;
          seen.push(req.op);
          sock.write(
            encodeFrame({
              id: req.id,
              ok: false,
              error: { name: "Error", message: `unknown daemon op: ${req.op}` },
            }),
          );
        }
      });
    });
    const server = fake;
    await new Promise<void>((resolve) => {
      server.listen(paths.socketPath, () => {
        resolve();
      });
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const direct = makePool({ rootDir: dataRoot });
    const seed = await direct.acquire(SOURCE);
    await seed.graphDb.upsertFile({ relPath: "cloned.ts", language: "typescript" }, NO_EDGES);
    await direct.closeAll();

    const session = makePool({ rootDir: dataRoot, daemonSocketPath: paths.socketPath });
    await session.cloneDatabase(SOURCE, TARGET);
    expect(await relPathsOnDisk(dataRoot, TARGET)).toEqual(["cloned.ts"]);
    await pools.at(-1)?.closeAll();
    await session.removeCollection(TARGET);

    expect(seen).toEqual(["cloneCollectionDatabase", "removeCollectionDatabase"]);
    expect(existsSync(session.pathFor(TARGET))).toBe(false);
  });
});
