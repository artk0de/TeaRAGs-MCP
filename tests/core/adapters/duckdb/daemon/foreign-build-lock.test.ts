/**
 * Another build's codegraph daemon holding a collection's DuckDB file (bd
 * tea-rags-mcp-hw27k).
 *
 * Build-keyed daemons (42hno) never share a socket, so two builds on one
 * machine run two daemons over the same collection files, and DuckDB lets only
 * one process hold a file read-write. Live on taxdome 2026-09-27: an agent
 * worktree's daemon, spawned by short `call get_naming_lexicon` runs, held the
 * file while a `--force-enrichments` run's own daemon waited out its open retry
 * op after op — 629.7 s of fileFinalize on a 26-file incremental — and every
 * read and write came back as a bare "Failed to open DuckDB".
 *
 * What is pinned here, against a REAL foreign daemon process (the compiled
 * entry under a forced build fingerprint) and one scratch database:
 *
 * - a foreign daemon with no client connected serves nobody: it is drained and
 *   the open proceeds at once;
 * - a foreign daemon with a client connected is not drained — draining it
 *   would cut that client — and once the open window runs out the failure
 *   names its pid and build; the next open of that collection does not wait
 *   the window again;
 * - the daemon wires this for its own pool, so a read through our daemon
 *   succeeds while an idle foreign daemon held the file.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { getBuildFingerprint } from "../../../../../src/core/adapters/duckdb/daemon/build-fingerprint.js";
import { DaemonGraphDbClient } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { ForeignBuildDaemonLockArbiter } from "../../../../../src/core/adapters/duckdb/daemon/foreign-build-lock-arbiter.js";
import {
  daemonPathsForKeyDir,
  getBuildKey,
  getDaemonPaths,
  isDaemonPidAlive,
  readDaemonPid,
  readRefs,
  type CodegraphDaemonPaths,
} from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import { CodegraphDatabaseHeldByForeignDaemonError } from "../../../../../src/core/adapters/duckdb/errors.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { createDatabaseMigrationApplier } from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const COLLECTION = "code_foreign_v1";
const FOREIGN_FINGERPRINT = "/elsewhere/worktree/build/core/adapters/duckdb/daemon|0.0.0|1";
const BUILD_ROOT = resolve(__dirname, "../../../../../build");

let root: string;
let storageDir: string;
const children: ChildProcess[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  if (root) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): void {
  root = mkdtempSync(join(tmpdir(), "cg-foreign-"));
  storageDir = join(root, "d");
  mkdirSync(join(root, "codegraph"), { recursive: true });
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A real daemon process of ANOTHER build: the compiled entry under a forced fingerprint. */
async function spawnForeignDaemon(): Promise<{ paths: CodegraphDaemonPaths; pid: number; child: ChildProcess }> {
  const paths = daemonPathsForKeyDir(join(storageDir, getBuildKey(FOREIGN_FINGERPRINT)));
  const child = spawn(process.execPath, [join(BUILD_ROOT, "core/adapters/duckdb/daemon/entry.js")], {
    env: {
      ...process.env,
      TEA_RAGS_CODEGRAPH_DAEMON_ROOT: root,
      TEA_RAGS_CODEGRAPH_DAEMON_DIR: storageDir,
      TEA_RAGS_CODEGRAPH_DAEMON_MIGRATIONS: pathToFileURL(
        join(BUILD_ROOT, "core/domains/maintenance/migration/database/index.js"),
      ).href,
      TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT: FOREIGN_FINGERPRINT,
      // Hold the file for the whole test: only a drain may release it.
      CODEGRAPH_DB_IDLE_EVICT_MS: "600000",
    },
    stdio: "ignore",
  });
  children.push(child);
  await waitFor(() => readDaemonPid(paths) === child.pid);
  return { paths, pid: child.pid!, child };
}

/** Make the foreign daemon open (and so lock) the collection, through a client of its own build. */
async function foreignOpensCollection(paths: CodegraphDaemonPaths): Promise<DaemonGraphDbClient> {
  const client = new DaemonGraphDbClient(paths.socketPath, COLLECTION);
  await client.init();
  await client.handshake(FOREIGN_FINGERPRINT);
  return client;
}

function makeLoserPool(openRetryMs: number): GraphDbClientPool {
  const pool = new GraphDbClientPool({
    rootDir: root,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    openRetry: { maxMs: openRetryMs, intervalMs: 100 },
    foreignBuildLockArbiter: new ForeignBuildDaemonLockArbiter({
      storageDir,
      ownBuildDir: getDaemonPaths(storageDir).buildDir,
      buildFingerprint: getBuildFingerprint(),
    }),
  });
  cleanups.push(async () => pool.closeAll());
  return pool;
}

describe("a foreign-build daemon holding the collection file (hw27k)", () => {
  it("drains a foreign daemon no client is connected to, and the open proceeds at once", async () => {
    makeRoot();
    const foreign = await spawnForeignDaemon();
    const client = await foreignOpensCollection(foreign.paths);
    await client.close();
    await waitFor(() => readRefs(foreign.paths) === 0);

    const pool = makeLoserPool(60_000);
    const started = Date.now();
    const handle = await pool.acquire(COLLECTION);

    expect(await handle.graphDb.listFileContentHashes()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(10_000);
    // Its pid file is gone and the process exited (a zombie still answers signal 0).
    await waitFor(() => foreign.child.exitCode !== null);
    expect(readDaemonPid(foreign.paths)).toBeUndefined();
  }, 30_000);

  it("leaves a foreign daemon with a connected client alone and names it when the open window runs out", async () => {
    makeRoot();
    const foreign = await spawnForeignDaemon();
    const client = await foreignOpensCollection(foreign.paths);
    cleanups.push(async () => client.close());

    const pool = makeLoserPool(1_500);
    const err = await pool.acquire(COLLECTION).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CodegraphDatabaseHeldByForeignDaemonError);
    const held = err as CodegraphDatabaseHeldByForeignDaemonError;
    expect(held.holderPid).toBe(foreign.pid);
    expect(held.message).toContain(String(foreign.pid));
    expect(held.message).toContain("/elsewhere/worktree/build");
    // Its client keeps working: nothing was drained.
    expect(isDaemonPidAlive(foreign.pid)).toBe(true);
    expect(await client.listFileContentHashes()).toEqual([]);

    // The same holder still has its client: the next open does not wait the
    // whole window again.
    const again = Date.now();
    await expect(pool.acquire(COLLECTION)).rejects.toBeInstanceOf(CodegraphDatabaseHeldByForeignDaemonError);
    expect(Date.now() - again).toBeLessThan(1_000);
  }, 30_000);

  it("a read through our own daemon succeeds while an idle foreign daemon held the file", async () => {
    makeRoot();
    const foreign = await spawnForeignDaemon();
    const client = await foreignOpensCollection(foreign.paths);
    await client.close();
    await waitFor(() => readRefs(foreign.paths) === 0);

    const ownPaths = getDaemonPaths(storageDir);
    const { DATABASE_MIGRATIONS_MODULE_URL } =
      await import("../../../../../src/core/domains/maintenance/migration/database/index.js");
    const { shutdown } = await runDaemon({
      rootDir: root,
      paths: ownPaths,
      migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
      exit: () => undefined,
    });
    cleanups.push(shutdown);
    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
      daemonSocketPath: ownPaths.socketPath,
    });
    cleanups.unshift(async () => pool.closeAll());

    const started = Date.now();
    const reader = await pool.acquireReader(COLLECTION);
    expect(await reader.graphDb.listFileContentHashes()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(10_000);
    // Its pid file is gone and the process exited (a zombie still answers signal 0).
    await waitFor(() => foreign.child.exitCode !== null);
    expect(readDaemonPid(foreign.paths)).toBeUndefined();
  }, 30_000);
});
