/**
 * Daemon build-version handshake — auto-restart integration tests
 * (bd tea-rags-mcp-ji56r).
 *
 * Drives the FULL restart loop against REAL daemons (`runDaemon`: real unix
 * socket, real `CodegraphDaemonServer`, real DuckDB pool) with an injected
 * build fingerprint + exit hook:
 *
 *   client handshake → fingerprint mismatch → client requests graceful
 *   shutdown → daemon drains via the idle-watcher path and exits → client
 *   waits for the lifecycle files to clear → cold-spawns a fresh daemon from
 *   ITS build (respawn hook) → reconnects → handshake matches → proceed.
 *
 * Match and legacy peers must NOT restart; a persistently-stale daemon (one
 * retry max) and a daemon that never exits surface typed errors.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodegraphDaemonExitTimeoutError,
  CodegraphDaemonStaleBuildError,
} from "../../../../../src/core/adapters/duckdb/errors.js";
import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { DATABASE_MIGRATIONS_MODULE_URL } from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { getDaemonPaths, type CodegraphDaemonPaths } from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { createDatabaseMigrationApplier } from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { setDebug } from "../../../../../src/core/infra/runtime.js";

let root: string;
const daemons: (() => Promise<void>)[] = [];
let fakeSrv: Server | undefined;

afterEach(async () => {
  setDebug(false);
  vi.restoreAllMocks();
  for (const shutdown of daemons.splice(0)) await shutdown().catch(() => undefined);
  await new Promise<void>((res) => {
    if (fakeSrv) {
      fakeSrv.close(() => {
        res();
      });
    } else {
      res();
    }
  });
  fakeSrv = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

function makePaths(): CodegraphDaemonPaths {
  root = mkdtempSync(join(tmpdir(), "cg-hs-"));
  const paths = getDaemonPaths(join(root, "d"));
  mkdirSync(paths.storageDir, { recursive: true });
  return paths;
}

/** Real daemon (real socket + server + DuckDB pool) with injected identity. */
async function startDaemon(paths: CodegraphDaemonPaths, buildFingerprint: string): Promise<void> {
  const { shutdown } = await runDaemon({
    rootDir: root,
    paths,
    buildFingerprint,
    migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
    // In-process stand-in for process.exit — runDaemon's drain path must not
    // kill the vitest worker. Lifecycle-file cleanup has already run by now.
    exit: () => undefined,
  });
  daemons.push(shutdown);
}

function makePool(
  paths: CodegraphDaemonPaths,
  restart: {
    buildFingerprint: string;
    respawn?: () => void;
    exitTimeoutMs?: number;
    pollIntervalMs?: number;
  },
): GraphDbClientPool {
  return new GraphDbClientPool({
    rootDir: root,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    daemonSocketPath: paths.socketPath,
    daemonRestart: restart,
  });
}

describe("daemon build-handshake auto-restart (integration, real spawned daemon)", () => {
  it("fingerprint mismatch drains the stale daemon, respawns from the client build, and reconnects", async () => {
    const paths = makePaths();
    await startDaemon(paths, "OLD-BUILD");

    setDebug(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    let respawns = 0;
    const pool = makePool(paths, {
      buildFingerprint: "NEW-BUILD",
      pollIntervalMs: 20,
      respawn: () => {
        respawns++;
        void startDaemon(paths, "NEW-BUILD");
      },
    });

    const handle = await pool.acquireWrite("code_hs_v1");
    expect(respawns).toBe(1);

    // The handle is live against the RESPAWNED daemon — a real write+read
    // round-trip through its DuckDB pool proves the reconnect.
    await handle.graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    expect(await handle.graphDb.hasData()).toBe(true);

    // The restart decision is logged to stderr under DEBUG.
    const lines = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(lines).toMatch(/build mismatch/i);

    await pool.closeAll();
  });

  it("matching fingerprints proceed WITHOUT restart (daemon stays up, respawn never fires)", async () => {
    const paths = makePaths();
    await startDaemon(paths, "SAME-BUILD");

    const respawn = vi.fn();
    const pool = makePool(paths, { buildFingerprint: "SAME-BUILD", respawn });

    const handle = await pool.acquireWrite("code_hs_match_v1");
    await handle.graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    expect(await handle.graphDb.hasData()).toBe(true);

    expect(respawn).not.toHaveBeenCalled();
    // The original daemon is still alive — its pid file was never cleaned up.
    expect(existsSync(paths.pidFile)).toBe(true);

    await pool.closeAll();
  });

  it("a LEGACY daemon (no fingerprint in the handshake response) proceeds WITHOUT restart", async () => {
    const paths = makePaths();
    // Legacy daemon: answers every op with null — the pre-fingerprint shape.
    fakeSrv = createServer((sock) => {
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const f of frames) {
          const req = JSON.parse(f) as DaemonRequest;
          sock.write(encodeFrame({ id: req.id, ok: true, result: null }));
        }
      });
    });
    fakeSrv.unref();
    await new Promise<void>((res) => {
      fakeSrv?.listen(paths.socketPath, () => {
        res();
      });
    });

    const respawn = vi.fn();
    const pool = makePool(paths, { buildFingerprint: "NEW-BUILD", respawn });

    const handle = await pool.acquireWrite("code_hs_legacy_v1");
    expect(handle.graphDb).toBeDefined();
    expect(respawn).not.toHaveBeenCalled();

    await pool.closeAll();
  });

  it("mismatch WITHOUT a respawn hook proceeds against the running daemon (worker pools cannot cold-spawn)", async () => {
    const paths = makePaths();
    await startDaemon(paths, "OLD-BUILD");

    // Worker-thread pools rebuild from serializable config — no respawn hook.
    // Draining a daemon they cannot resurrect would strand codegraph for the
    // whole machine, so the mismatch must be TOLERATED (status quo behavior).
    const pool = makePool(paths, { buildFingerprint: "NEW-BUILD" });

    const handle = await pool.acquireWrite("code_hs_nohook_v1");
    await handle.graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    expect(await handle.graphDb.hasData()).toBe(true);
    // The stale daemon is still alive — nothing drained it.
    expect(existsSync(paths.pidFile)).toBe(true);

    await pool.closeAll();
  });

  it("throws CodegraphDaemonStaleBuildError when the daemon is STILL stale after the single retry", async () => {
    const paths = makePaths();
    await startDaemon(paths, "OLD-BUILD-1");

    let respawns = 0;
    const pool = makePool(paths, {
      buildFingerprint: "NEW-BUILD",
      pollIntervalMs: 20,
      respawn: () => {
        respawns++;
        // The respawned daemon is ALSO from a different build — retry must not loop.
        void startDaemon(paths, "OLD-BUILD-2");
      },
    });

    await expect(pool.acquireWrite("code_hs_stale_v1")).rejects.toThrow(CodegraphDaemonStaleBuildError);
    expect(respawns).toBe(1);

    await pool.closeAll();
  });

  it("throws CodegraphDaemonExitTimeoutError when the stale daemon never exits", async () => {
    const paths = makePaths();
    // Fake stale daemon: presents a mismatched fingerprint, ACKS the shutdown
    // request, but never actually exits (pid file stays, pid stays alive).
    fakeSrv = createServer((sock) => {
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const f of frames) {
          const req = JSON.parse(f) as DaemonRequest;
          const result = req.op === "handshake" ? { buildFingerprint: "WEDGED-OLD" } : null;
          sock.write(encodeFrame({ id: req.id, ok: true, result }));
        }
      });
    });
    fakeSrv.unref();
    await new Promise<void>((res) => {
      fakeSrv?.listen(paths.socketPath, () => {
        res();
      });
    });
    // A live pid — the wedged daemon "keeps running" for the whole wait window.
    writeFileSync(paths.pidFile, String(process.pid), "utf-8");

    const respawn = vi.fn();
    const pool = makePool(paths, {
      buildFingerprint: "NEW-BUILD",
      respawn,
      exitTimeoutMs: 250,
      pollIntervalMs: 20,
    });

    await expect(pool.acquireWrite("code_hs_wedged_v1")).rejects.toThrow(CodegraphDaemonExitTimeoutError);
    // No cold spawn on top of a daemon that still holds the socket + RW lock.
    expect(respawn).not.toHaveBeenCalled();

    await pool.closeAll();
  });
});
