/**
 * Build-keyed daemon connect flow (bd tea-rags-mcp-42hno).
 *
 * A client looks up ITS build's keyed socket: found + alive → connect (same
 * build by construction; the handshake stays as the op-capability check);
 * miss → the existing respawn path spawns a keyed daemon. A pool without a
 * respawn hook (worker thread) gets a typed RETRYABLE error on an own-key
 * miss instead of silently sharing another build's daemon. The first keyed
 * client that meets a LEGACY (un-keyed) layout drains that daemon through the
 * existing flow — the zgcmo guard protects its in-flight writers — then
 * unlinks the legacy files; a dead legacy pid is unlinked directly.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import {
  getDaemonPaths,
  getLegacyDaemonPaths,
  type CodegraphDaemonPaths,
} from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import {
  CodegraphDaemonBuildUnavailableError,
  isCodegraphUnavailableError,
} from "../../../../../src/core/adapters/duckdb/errors.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import {
  createDatabaseMigrationApplier,
  DATABASE_MIGRATIONS_MODULE_URL,
} from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const COLLECTION = "code_keyed_v1";

let root: string;
const daemons: (() => Promise<void>)[] = [];
const pools: GraphDbClientPool[] = [];

afterEach(async () => {
  for (const shutdown of daemons.splice(0)) await shutdown().catch(() => undefined);
  for (const pool of pools.splice(0)) await pool.closeAll().catch(() => undefined);
  if (root) rmSync(root, { recursive: true, force: true });
});

function makePaths(): CodegraphDaemonPaths {
  root = mkdtempSync(join(tmpdir(), "cg-keyed-c-"));
  const paths = getDaemonPaths(join(root, "d"));
  mkdirSync(paths.buildDir, { recursive: true });
  return paths;
}

/** Real keyed daemon (real socket + server + DuckDB pool), in-process. */
async function startKeyedDaemon(paths: CodegraphDaemonPaths): Promise<void> {
  const { shutdown } = await runDaemon({
    rootDir: root,
    paths,
    migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
    exit: () => undefined,
  });
  daemons.push(shutdown);
}

function makePool(
  paths: CodegraphDaemonPaths,
  opts: { respawn?: () => void; daemonStorageDir?: string } = {},
): GraphDbClientPool {
  const pool = new GraphDbClientPool({
    rootDir: root,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    daemonSocketPath: paths.socketPath,
    ...(opts.daemonStorageDir !== undefined ? { daemonStorageDir: opts.daemonStorageDir } : {}),
    ...(opts.respawn !== undefined ? { daemonRestart: { respawn: opts.respawn } } : {}),
  });
  pools.push(pool);
  return pool;
}

/**
 * The bootstrap factory wraps `acquireWrite`/`acquireReader` with its
 * ensure-spawn hook — the pool itself spawns only from the handshake restart
 * loop. Tests that expect a spawn on an own-key miss mirror that wiring.
 */
function wireEnsure(pool: GraphDbClientPool, ensure: () => void): void {
  const write = pool.acquireWrite.bind(pool);
  pool.acquireWrite = async (collectionName) => {
    ensure();
    return write(collectionName);
  };
}

describe("build-keyed connect flow (42hno)", () => {
  it("connects to the OWN build's keyed daemon without spawning (same build by construction)", async () => {
    const paths = makePaths();
    await startKeyedDaemon(paths);

    const respawn = vi.fn();
    const pool = makePool(paths, { respawn });

    const handle = await pool.acquireWrite(COLLECTION);
    await handle.graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    expect(await handle.graphDb.hasData()).toBe(true);
    expect(respawn).not.toHaveBeenCalled();
    expect(existsSync(paths.pidFile)).toBe(true);
  });

  it("an own-key miss respawns and the daemon lands IN the own build's key directory", async () => {
    const paths = makePaths();
    const respawn = vi.fn(() => {
      void startKeyedDaemon(paths);
    });
    const pool = makePool(paths, { respawn });
    wireEnsure(pool, respawn);

    const handle = await pool.acquireWrite(COLLECTION);
    await handle.graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    expect(await handle.graphDb.hasData()).toBe(true);
    expect(respawn).toHaveBeenCalled();
    expect(existsSync(paths.pidFile)).toBe(true);
  });

  it("a pool WITHOUT a respawn hook gets the retryable build-unavailable error on an own-key miss", async () => {
    const paths = makePaths();
    const pool = makePool(paths);

    const err = await pool.acquireWrite(COLLECTION).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(CodegraphDaemonBuildUnavailableError);
    expect(isCodegraphUnavailableError(err)).toBe(true);
    expect((err as Error).message).toContain(paths.socketPath);
  });

  it("the first keyed client drains a live LEGACY daemon, unlinks its files, and lands on the keyed daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-keyed-l-"));
    root = dir;
    const paths = getDaemonPaths(dir);
    mkdirSync(paths.buildDir, { recursive: true });
    const legacy = getLegacyDaemonPaths(dir);

    let legacyExited = false;
    const legacyDaemon = await runDaemon({
      rootDir: root,
      paths: legacy,
      migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
      exit: () => {
        legacyExited = true;
      },
    });
    daemons.push(legacyDaemon.shutdown);
    expect(existsSync(legacy.pidFile)).toBe(true);

    const respawn = vi.fn(() => {
      void startKeyedDaemon(paths);
    });
    const pool = makePool(paths, { respawn, daemonStorageDir: dir });
    wireEnsure(pool, respawn);

    const handle = await pool.acquireWrite(COLLECTION);
    await handle.graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    expect(await handle.graphDb.hasData()).toBe(true);

    // The legacy daemon was drained through the existing flow and its layout
    // removed; the client ended up on ITS build's keyed daemon.
    expect(legacyExited).toBe(true);
    expect(existsSync(legacy.pidFile)).toBe(false);
    expect(existsSync(legacy.socketPath)).toBe(false);
    expect(existsSync(paths.pidFile)).toBe(true);
  });

  it("a DEAD legacy pid's files are unlinked directly, with no drain attempted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-keyed-d-"));
    root = dir;
    const paths = getDaemonPaths(dir);
    mkdirSync(paths.buildDir, { recursive: true });
    const legacy = getLegacyDaemonPaths(dir);
    mkdirSync(dir, { recursive: true });
    // The pid of this test process is alive, but the daemon socket is gone —
    // the shape of a legacy daemon that exited without cleanup is instead
    // pinned by the dead-pid arm below; here a stale socket + readable-but-
    // unrelated pid must NOT be drained (no socket to drain).
    writeFileSync(legacy.socketPath, "stale", "utf-8");
    const deadChild = await import("node:child_process").then(async ({ spawn }) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      return new Promise<{ pid: number }>((resolve) =>
        child.once("exit", () => {
          resolve({ pid: child.pid });
        }),
      );
    });
    writeFileSync(legacy.pidFile, String(deadChild.pid), "utf-8");

    const respawn = vi.fn(() => {
      void startKeyedDaemon(paths);
    });
    const pool = makePool(paths, { respawn, daemonStorageDir: dir });
    wireEnsure(pool, respawn);

    const handle = await pool.acquireWrite(COLLECTION);
    await handle.graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    expect(await handle.graphDb.hasData()).toBe(true);

    // No daemon was listening on the legacy socket, so the files are simply
    // unlinked and the client lands on its keyed daemon.
    expect(existsSync(legacy.pidFile)).toBe(false);
    expect(existsSync(legacy.socketPath)).toBe(false);
    expect(existsSync(paths.pidFile)).toBe(true);
  });

  it("a pool without daemonStorageDir never looks for a legacy layout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-keyed-n-"));
    root = dir;
    const paths = getDaemonPaths(dir);
    mkdirSync(paths.buildDir, { recursive: true });
    const legacy = getLegacyDaemonPaths(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(legacy.pidFile, "not-a-pid", "utf-8");

    const respawn = vi.fn(() => {
      void startKeyedDaemon(paths);
    });
    // daemonStorageDir deliberately NOT set (the worker-pool shape).
    const pool = makePool(paths, { respawn });
    wireEnsure(pool, respawn);

    const handle = await pool.acquireWrite(COLLECTION);
    await handle.graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    expect(await handle.graphDb.hasData()).toBe(true);
    // The legacy file the pool was never told about is untouched.
    expect(existsSync(legacy.pidFile)).toBe(true);
  });
});

describe("cross-build shared-collection open retry (42hno)", () => {
  it("the losing opener retries the DuckDB open until the holder releases", async () => {
    const { spawn } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "cg-keyed-r-"));
    root = dir;
    mkdirSync(join(dir, "codegraph"), { recursive: true });
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          'const { DuckDBInstance } = await import("@duckdb/node-api");',
          "const db = await DuckDBInstance.create(process.env.HOLD_DB_PATH);",
          "const conn = await db.connect();",
          'await conn.run("CREATE TABLE IF NOT EXISTS keep (id INTEGER)");',
          'console.log("HOLDING");',
          "process.stdin.resume();",
        ].join("\n"),
      ],
      {
        env: { ...process.env, HOLD_DB_PATH: join(dir, "codegraph", "code_retry_v1.duckdb") },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on("data", (d: Buffer) => {
        if (d.toString().includes("HOLDING")) resolve();
      });
      holder.stderr.on("data", (d: Buffer) => {
        reject(new Error(d.toString()));
      });
    });
    try {
      const base = {
        rootDir: dir,
        symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
        applyMigrations: createDatabaseMigrationApplier(),
      };
      const loser = new GraphDbClientPool({ ...base, openRetry: { maxMs: 20_000, intervalMs: 100 } });
      pools.push(loser);

      let settled = false;
      const pending = loser.acquire("code_retry_v1");
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((r) => setTimeout(r, 500));
      // Still retrying — the external holder owns the RW lock.
      expect(settled).toBe(false);

      holder.kill("SIGKILL");
      const handle = await pending;
      // The retry succeeded once the lock was released: the file is real and
      // the loser's client is live on it.
      expect(handle.graphDb).toBeDefined();
      expect(loser.hasDatabase("code_retry_v1")).toBe(true);
      await loser.closeAll();
    } finally {
      if (!holder.killed) holder.kill("SIGKILL");
    }
  });

  it("without openRetry the losing opener fails fast with the typed open error", async () => {
    const { DuckDbOpenFailedError } = await import("../../../../../src/core/adapters/duckdb/errors.js");
    const { spawn } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "cg-keyed-f-"));
    root = dir;
    mkdirSync(join(dir, "codegraph"), { recursive: true });
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          'const { DuckDBInstance } = await import("@duckdb/node-api");',
          "const db = await DuckDBInstance.create(process.env.HOLD_DB_PATH);",
          'console.log("HOLDING");',
          "process.stdin.resume();",
        ].join("\n"),
      ],
      {
        env: { ...process.env, HOLD_DB_PATH: join(dir, "codegraph", "code_retry_off_v1.duckdb") },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    await new Promise<void>((resolve) => {
      holder.stdout.on("data", (d: Buffer) => {
        if (d.toString().includes("HOLDING")) resolve();
      });
    });
    try {
      const pool = new GraphDbClientPool({
        rootDir: dir,
        symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
        applyMigrations: createDatabaseMigrationApplier(),
      });
      pools.push(pool);
      await expect(pool.acquire("code_retry_off_v1")).rejects.toBeInstanceOf(DuckDbOpenFailedError);
    } finally {
      holder.kill("SIGKILL");
    }
  });
});
