/**
 * Which build-key directory a client process talks to (bd tea-rags-mcp-llrja).
 *
 * The daemon key dir is derived from a build fingerprint. A long-lived MCP
 * server that outlives `npm run build` still LOADED the old build, so keying
 * the client by its loaded fingerprint addresses the old key dir — while every
 * daemon spawned from this tree now runs the NEW build and lands in the new
 * key dir. The client then waited the whole connect window on a socket that
 * never appeared, on every graph call.
 *
 * The client side therefore addresses the key dir of the build ON DISK — the
 * one a daemon spawned from this tree actually uses — and the existing 1wr7p
 * handshake decides what the stale process may do there (read-only, or the
 * typed stale-client error). A process whose build tree is gone cannot spawn
 * anything: with no daemon of its loaded build listening it fails fast.
 *
 * Fixture shape (shared with client-stale-handshake.test.ts): a client whose
 * loaded fingerprint comes from a fixture module that is then rewritten on
 * disk; REAL daemons (`runDaemon`) serve the sockets.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import {
  captureBuildFingerprint,
  type BuildFingerprintCapture,
} from "../../../../../src/core/adapters/duckdb/daemon/build-fingerprint.js";
import { DaemonGraphDbClient } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import {
  getBuildKey,
  getDaemonPaths,
  getDaemonPathsForBuild,
  resolveDaemonClientTarget,
  type CodegraphDaemonPaths,
} from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import {
  CodegraphClientBuildTreeGoneError,
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

let root: string | undefined;
const daemons: (() => Promise<void>)[] = [];
const pools: GraphDbClientPool[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const pool of pools.splice(0)) await pool.closeAll().catch(() => undefined);
  for (const shutdown of daemons.splice(0)) await shutdown().catch(() => undefined);
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makeStorageDir(): string {
  root = mkdtempSync(join(tmpdir(), "cg-llrja-"));
  return join(root, "d");
}

/** The fixture build-fingerprint module a client "loaded". */
function fixtureModule(): string {
  const buildDir = join(root as string, "build");
  const daemonDir = join(buildDir, "core", "daemon");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(join(buildDir, "package.json"), JSON.stringify({ name: "tea-rags", version: "1.43.0" }), "utf-8");
  const moduleFile = join(daemonDir, "build-fingerprint.js");
  writeFileSync(moduleFile, "// build A\n", "utf-8");
  return moduleFile;
}

/** Loaded build A; `npm run build` then rewrote the module in place → on disk is B. */
function rebuiltUnderClient(): BuildFingerprintCapture {
  const moduleFile = fixtureModule();
  const capture = captureBuildFingerprint(moduleFile);
  const later = new Date(Date.now() + 5_000);
  utimesSync(moduleFile, later, later);
  return capture;
}

/** Loaded build A; the whole tree was then removed (`npm i -g` upgrade, worktree deleted). */
function treeGoneUnderClient(): BuildFingerprintCapture {
  const moduleFile = fixtureModule();
  const capture = captureBuildFingerprint(moduleFile);
  rmSync(join(root as string, "build"), { recursive: true, force: true });
  return capture;
}

function sourceOf(capture: BuildFingerprintCapture): { loaded: () => string; onDisk: () => string | undefined } {
  return { loaded: () => capture.loaded, onDisk: capture.readOnDisk };
}

/** Real in-process daemon; returns its exit hook, which a drain ends in. */
async function startDaemon(paths: CodegraphDaemonPaths, buildFingerprint: string): Promise<ReturnType<typeof vi.fn>> {
  mkdirSync(paths.buildDir, { recursive: true });
  const exit = vi.fn();
  const { shutdown } = await runDaemon({
    rootDir: root as string,
    paths,
    buildFingerprint,
    migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
    exit,
  });
  daemons.push(shutdown);
  return exit;
}

/**
 * The pool exactly as the bootstrap factory wires it: the wire-time socket of
 * the loaded build, the base storage dir, and the client-target resolver that
 * re-decides the key dir at every connect.
 */
function makeFactoryShapedPool(
  storageDir: string,
  client: BuildFingerprintCapture,
  restart: { respawn?: () => void } = {},
): GraphDbClientPool {
  const pool = new GraphDbClientPool({
    rootDir: root as string,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    daemonSocketPath: getDaemonPathsForBuild(storageDir, client.loaded).socketPath,
    daemonStorageDir: storageDir,
    daemonClientTarget: () => resolveDaemonClientTarget(storageDir, sourceOf(client)),
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

describe("resolveDaemonClientTarget — the one rule for the client's key dir (bd tea-rags-mcp-llrja)", () => {
  it("a process running the build on disk addresses its own build's key dir — the getDaemonPaths layout", () => {
    const storageDir = makeStorageDir();

    const target = resolveDaemonClientTarget(storageDir);

    expect(target.addressing).toBe("own-build");
    expect(target.paths).toEqual(getDaemonPaths(storageDir));
  });

  it("a process that predates the build on disk addresses the ON-DISK build's key dir", () => {
    const storageDir = makeStorageDir();
    const client = rebuiltUnderClient();
    const onDisk = client.readOnDisk() as string;

    const target = resolveDaemonClientTarget(storageDir, sourceOf(client));

    expect(target.addressing).toBe("on-disk-build");
    expect(target.paths).toEqual(getDaemonPathsForBuild(storageDir, onDisk));
    expect(target.paths.buildDir).toBe(join(storageDir, getBuildKey(onDisk)));
    expect(target.paths.storageDir).toBe(storageDir);
    expect(target.loadedFingerprint).toBe(client.loaded);
    expect(target.onDiskFingerprint).toBe(onDisk);
  });

  it("a process whose build tree is gone keeps its loaded build's key dir and says so", () => {
    const storageDir = makeStorageDir();
    const client = treeGoneUnderClient();

    const target = resolveDaemonClientTarget(storageDir, sourceOf(client));

    expect(target.addressing).toBe("build-tree-gone");
    expect(target.paths).toEqual(getDaemonPathsForBuild(storageDir, client.loaded));
    expect(target.onDiskFingerprint).toBeUndefined();
  });

  it("the fingerprint env override makes both views one identity", () => {
    const storageDir = makeStorageDir();
    vi.stubEnv("TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT", "forced-llrja");

    const target = resolveDaemonClientTarget(storageDir);

    expect(target.addressing).toBe("own-build");
    expect(target.paths).toEqual(getDaemonPathsForBuild(storageDir, "forced-llrja"));
  });
});

describe("a stale client process reaches the daemon of the on-disk build (bd tea-rags-mcp-llrja)", () => {
  it("connects to the on-disk build's key dir and proceeds read-only — no drain, no respawn, no connect-window wait", async () => {
    const storageDir = makeStorageDir();
    const client = rebuiltUnderClient();
    const onDisk = client.readOnDisk() as string;
    // A fresh process spawned the daemon from the rebuilt tree: it owns the NEW key dir.
    const onDiskPaths = getDaemonPathsForBuild(storageDir, onDisk);
    const daemonExit = await startDaemon(onDiskPaths, onDisk);
    const requestShutdown = vi.spyOn(DaemonGraphDbClient.prototype, "requestShutdown");
    const respawn = vi.fn();
    const pool = makeFactoryShapedPool(storageDir, client, { respawn });

    const started = Date.now();
    const { graphDb } = await pool.acquireWrite(fixturePhysicalCollectionName("code_llrja_ro_v1"));

    expect(Date.now() - started).toBeLessThan(3_000);
    await expect(graphDb.getCallers("a.ts#f")).resolves.toEqual([]);
    // The 1wr7p outcome, unchanged: the stale process may read, never write.
    const err = await graphDb
      .upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodegraphClientStaleBuildError);
    expect(requestShutdown).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(daemonExit).not.toHaveBeenCalled();
    expect(existsSync(onDiskPaths.pidFile)).toBe(true);
  });

  it("a non-stale client of the same factory-shaped pool still connects to its own build's daemon and writes", async () => {
    const storageDir = makeStorageDir();
    const client = rebuiltUnderClient();
    const current: BuildFingerprintCapture = { loaded: client.loaded, readOnDisk: () => client.loaded };
    await startDaemon(getDaemonPathsForBuild(storageDir, current.loaded), current.loaded);
    const pool = makeFactoryShapedPool(storageDir, current);

    const { graphDb } = await pool.acquireWrite(fixturePhysicalCollectionName("code_llrja_own_v1"));
    await graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });

    expect(await graphDb.hasData()).toBe(true);
  });
});

describe("a client whose build tree is gone fails fast (bd tea-rags-mcp-llrja)", () => {
  it("throws the typed build-tree-gone error at once when no daemon of its loaded build is listening", async () => {
    const storageDir = makeStorageDir();
    const client = treeGoneUnderClient();
    const respawn = vi.fn();
    const pool = makeFactoryShapedPool(storageDir, client, { respawn });

    const started = Date.now();
    const err = await pool.acquireWrite(fixturePhysicalCollectionName("code_llrja_gone_v1")).catch((e: unknown) => e);

    // Well under the 5s connect window the old behaviour waited out.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(err).toBeInstanceOf(CodegraphClientBuildTreeGoneError);
    expect(err).toBeInstanceOf(InfraError);
    const gone = err as CodegraphClientBuildTreeGoneError;
    expect(gone.code).toBe("INFRA_CODEGRAPH_CLIENT_BUILD_TREE_GONE");
    expect(gone.message).toContain(client.loaded);
    expect(gone.message).toContain("/mcp reconnect");
    expect(isCodegraphUnavailableError(err)).toBe(true);
  });

  it("still reaches a daemon of its loaded build that is listening", async () => {
    const storageDir = makeStorageDir();
    const client = treeGoneUnderClient();
    await startDaemon(getDaemonPathsForBuild(storageDir, client.loaded), client.loaded);
    const pool = makeFactoryShapedPool(storageDir, client);

    const { graphDb } = await pool.acquireWrite(fixturePhysicalCollectionName("code_llrja_gone_live_v1"));

    expect(await graphDb.hasData()).toBe(false);
  });
});
