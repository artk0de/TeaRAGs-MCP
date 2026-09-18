/**
 * Build handshake when the CLIENT is the stale side (bd tea-rags-mcp-1wr7p).
 *
 * A long-lived MCP server keeps running the code it loaded; a rebuild,
 * `npm link` or `npm i -g` upgrade rewrites the build under it, and the next
 * daemon anyone spawns comes from that NEW build. The handshake then sees a
 * mismatch — but the daemon is the up-to-date peer. Draining it cannot
 * converge (every respawn launches the same on-disk build), and every drain
 * cuts the connection of each session already on the new build.
 *
 * These tests drive REAL daemons (`runDaemon`: real socket, server, DuckDB
 * pool) against a client whose loaded fingerprint comes from a fixture module
 * that is then rewritten on disk — the exact shape of a rebuild under a live
 * process. The daemon's `exit` hook is the drain evidence: a client-requested
 * shutdown ends in it.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureBuildFingerprint,
  type BuildFingerprintCapture,
} from "../../../../../src/core/adapters/duckdb/daemon/build-fingerprint.js";
import { DaemonGraphDbClient } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { getDaemonPaths, type CodegraphDaemonPaths } from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import {
  DAEMON_OP_COMMANDS,
  type DaemonOpCommand,
} from "../../../../../src/core/adapters/duckdb/daemon/op-commands.js";
import type { DaemonOp } from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import {
  CodegraphClientStaleBuildError,
  isCodegraphUnavailableError,
} from "../../../../../src/core/adapters/duckdb/errors.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { InfraError } from "../../../../../src/core/adapters/errors.js";
import {
  createDatabaseMigrationApplier,
  DATABASE_MIGRATIONS_MODULE_URL,
} from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { setDebug } from "../../../../../src/core/infra/runtime.js";

let root: string | undefined;
const daemons: (() => Promise<void>)[] = [];
const pools: GraphDbClientPool[] = [];

afterEach(async () => {
  setDebug(false);
  vi.restoreAllMocks();
  for (const pool of pools.splice(0)) await pool.closeAll().catch(() => undefined);
  for (const shutdown of daemons.splice(0)) await shutdown().catch(() => undefined);
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makePaths(): CodegraphDaemonPaths {
  root = mkdtempSync(join(tmpdir(), "cg-cstale-"));
  const paths = getDaemonPaths(join(root, "d"));
  mkdirSync(paths.storageDir, { recursive: true });
  return paths;
}

/**
 * A client that loaded build A, whose module file on disk was then rewritten to
 * build B — `loaded` is A, `readOnDisk()` is B.
 */
function rebuiltUnderClient(): BuildFingerprintCapture {
  const buildDir = join(root as string, "build");
  const daemonDir = join(buildDir, "core", "daemon");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(join(buildDir, "package.json"), JSON.stringify({ name: "tea-rags", version: "1.42.0" }), "utf-8");
  const moduleFile = join(daemonDir, "build-fingerprint.js");
  writeFileSync(moduleFile, "// build A\n", "utf-8");
  const capture = captureBuildFingerprint(moduleFile);
  // `npm run build` rewrites the artifact in place.
  const later = new Date(Date.now() + 5_000);
  utimesSync(moduleFile, later, later);
  return capture;
}

/** The real op table minus `ops` — a build that dropped them. */
function withoutOps(...ops: DaemonOp[]): Partial<Record<DaemonOp, DaemonOpCommand>> {
  return Object.fromEntries(Object.entries(DAEMON_OP_COMMANDS).filter(([op]) => !ops.includes(op as DaemonOp)));
}

/** Real in-process daemon; returns its exit hook, which a drain ends in. */
async function startDaemon(
  paths: CodegraphDaemonPaths,
  buildFingerprint: string,
  opCommands?: Partial<Record<DaemonOp, DaemonOpCommand>>,
): Promise<ReturnType<typeof vi.fn>> {
  const exit = vi.fn();
  const { shutdown } = await runDaemon({
    rootDir: root as string,
    paths,
    buildFingerprint,
    migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
    ...(opCommands ? { opCommands } : {}),
    exit,
  });
  daemons.push(shutdown);
  return exit;
}

function makePool(
  paths: CodegraphDaemonPaths,
  client: BuildFingerprintCapture,
  restart: { respawn?: () => void } = {},
): GraphDbClientPool {
  const pool = new GraphDbClientPool({
    rootDir: root as string,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    daemonSocketPath: paths.socketPath,
    daemonRestart: {
      buildFingerprint: client.loaded,
      readOnDiskBuildFingerprint: client.readOnDisk,
      pollIntervalMs: 20,
      restartDelayMs: 5,
      ...restart,
    },
  });
  pools.push(pool);
  return pool;
}

describe("stale CLIENT meets the up-to-date daemon (bd tea-rags-mcp-1wr7p)", () => {
  it("proceeds against the daemon of the on-disk build without draining or respawning it", async () => {
    const paths = makePaths();
    const client = rebuiltUnderClient();
    const onDisk = client.readOnDisk() as string;
    expect(onDisk).not.toBe(client.loaded);
    const daemonExit = await startDaemon(paths, onDisk);

    setDebug(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const requestShutdown = vi.spyOn(DaemonGraphDbClient.prototype, "requestShutdown");
    const respawn = vi.fn();
    const pool = makePool(paths, client, { respawn });

    const handle = await pool.acquireWrite("code_cstale_ok_v1");
    // Live against the running daemon — a real read round-trip. It proceeds
    // READ-ONLY: writes are pinned by the read-only test below.
    expect(await handle.graphDb.hasData()).toBe(false);

    expect(requestShutdown).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(daemonExit).not.toHaveBeenCalled();
    expect(existsSync(paths.pidFile)).toBe(true);
    // Under DEBUG the decision says which side is stale.
    const lines = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(lines).toMatch(/this process predates the build on disk/i);
  });

  // The capability table checks op NAMES only; a write whose payload shape
  // moved under an unchanged name would land in the store unnoticed. So a
  // client that proceeds against a newer daemon may read, never write.
  it("a stale client that proceeds is read-only: graph reads work, every write throws the typed stale-client error", async () => {
    const paths = makePaths();
    const client = rebuiltUnderClient();
    const onDisk = client.readOnDisk() as string;
    await startDaemon(paths, onDisk);
    const pool = makePool(paths, client, { respawn: vi.fn() });

    const { graphDb } = await pool.acquireWrite("code_cstale_ro_v1");

    // The reads get_callers / get_callees / trace_path / find_cycles issue.
    await expect(graphDb.getCallers("a.ts#f")).resolves.toEqual([]);
    await expect(graphDb.getCallees("a.ts#f")).resolves.toEqual([]);
    await expect(graphDb.findCycles("file")).resolves.toEqual([]);
    await expect(graphDb.getSymbolRelPaths([])).resolves.toEqual(new Map());

    const err = await graphDb
      .upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodegraphClientStaleBuildError);
    expect(isCodegraphUnavailableError(err)).toBe(true);
    const stale = err as CodegraphClientStaleBuildError;
    expect(stale.message).toContain("upsertFile");
    expect(stale.message).toContain(client.loaded);
    expect(stale.message).toContain(onDisk);
    expect(stale.message).toContain("/mcp reconnect");
    await expect(graphDb.computeAndPersistCyclesAndSignals?.()).rejects.toBeInstanceOf(CodegraphClientStaleBuildError);
    await expect(graphDb.checkpoint()).rejects.toBeInstanceOf(CodegraphClientStaleBuildError);

    // Nothing reached the store.
    expect(await graphDb.hasData()).toBe(false);
  });

  it("a client of the daemon's own build keeps writing", async () => {
    const paths = makePaths();
    const client = rebuiltUnderClient();
    await startDaemon(paths, client.loaded);
    const pool = makePool(paths, { loaded: client.loaded, readOnDisk: () => client.loaded });

    const { graphDb } = await pool.acquireWrite("code_cstale_fresh_v1");
    await graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    expect(await graphDb.hasData()).toBe(true);
  });

  it("fails fast with the typed client-stale error when the new daemon lacks an op this client requires", async () => {
    const paths = makePaths();
    const client = rebuiltUnderClient();
    const onDisk = client.readOnDisk() as string;
    const daemonExit = await startDaemon(paths, onDisk, withoutOps("listAllPass1Aggregates"));

    const requestShutdown = vi.spyOn(DaemonGraphDbClient.prototype, "requestShutdown");
    const respawn = vi.fn();
    const pool = makePool(paths, client, { respawn });

    const err = await pool.acquireWrite("code_cstale_short_v1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CodegraphClientStaleBuildError);
    expect(err).toBeInstanceOf(InfraError);
    const stale = err as CodegraphClientStaleBuildError;
    expect(stale.code).toBe("INFRA_CODEGRAPH_CLIENT_STALE_BUILD");
    expect(stale.missingOps).toEqual(["listAllPass1Aggregates"]);
    expect(stale.message).toContain("/mcp reconnect");
    expect(stale.message).toContain(client.loaded);
    expect(stale.message).toContain(onDisk);
    // Optional codegraph consumers degrade on it like the rest of the family.
    expect(isCodegraphUnavailableError(err)).toBe(true);

    // Zero drains, zero respawns: the daemon is the up-to-date peer.
    expect(requestShutdown).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(daemonExit).not.toHaveBeenCalled();
    expect(existsSync(paths.pidFile)).toBe(true);
  });

  it("a pool without a respawn hook names the stale client, not the daemon, when it must refuse", async () => {
    const paths = makePaths();
    const client = rebuiltUnderClient();
    await startDaemon(paths, client.readOnDisk() as string, withoutOps("listAllPass1Aggregates"));

    const pool = makePool(paths, client);

    await expect(pool.acquireWrite("code_cstale_hookless_v1")).rejects.toThrow(CodegraphClientStaleBuildError);
    expect(existsSync(paths.pidFile)).toBe(true);
  });

  // A stale client can also meet a daemon older than both builds. That daemon
  // IS worth replacing — once. The replacement comes from the on-disk build,
  // and from then on the client is the stale side: draining it again would
  // take down the correct daemon for every other session.
  it("drains an older foreign daemon once, then proceeds against the on-disk build without draining it", async () => {
    const paths = makePaths();
    const client = rebuiltUnderClient();
    const onDisk = client.readOnDisk() as string;
    const foreignExit = await startDaemon(paths, "OLDER-FOREIGN-BUILD");

    const requestShutdown = vi.spyOn(DaemonGraphDbClient.prototype, "requestShutdown");
    let respawnedExit: ReturnType<typeof vi.fn> | undefined;
    let respawns = 0;
    const pool = makePool(paths, client, {
      respawn: () => {
        respawns++;
        void startDaemon(paths, onDisk).then((exit) => {
          respawnedExit = exit;
        });
      },
    });

    const handle = await pool.acquireWrite("code_cstale_foreign_v1");
    // A live read round-trip; the stale client proceeds read-only.
    expect(await handle.graphDb.hasData()).toBe(false);

    expect(respawns).toBe(1);
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(foreignExit).toHaveBeenCalledTimes(1);
    expect(respawnedExit).toBeDefined();
    expect(respawnedExit).not.toHaveBeenCalled();
  });

  it("an unreadable on-disk build cannot prove the client stale — the daemon is replaced as before", async () => {
    const paths = makePaths();
    await startDaemon(paths, "DAEMON-BUILD");

    let respawns = 0;
    const pool = new GraphDbClientPool({
      rootDir: root as string,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
      daemonSocketPath: paths.socketPath,
      daemonRestart: {
        buildFingerprint: "CLIENT-BUILD",
        readOnDiskBuildFingerprint: () => undefined,
        pollIntervalMs: 20,
        respawn: () => {
          respawns++;
          void startDaemon(paths, "CLIENT-BUILD");
        },
      },
    });
    pools.push(pool);

    await pool.acquireWrite("code_cstale_unreadable_v1");
    expect(respawns).toBe(1);
  });
});
