/**
 * Daemon capability handshake (bd tea-rags-mcp-39xca.4).
 *
 * A client from a newer build meeting a daemon from an older one used to learn
 * about a missing op only at call time, where four client methods turned
 * `unknown daemon op` into an empty answer — and a worker-thread pool (no
 * respawn hook) proceeded against that daemon regardless, so a new op against
 * an old daemon became wrong data (the weno4 hydration no-op).
 *
 * These tests pin the loud replacement: the handshake advertises the ops the
 * daemon actually dispatches; a pool that cannot respawn refuses a daemon that
 * lacks a required op; a pool that can respawn replaces it; and only the
 * explicitly tolerated ops may degrade — audibly, once per op.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DaemonGraphDbClient,
  LEGACY_TOLERATED_OPS,
  REQUIRED_DAEMON_OPS,
} from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { getDaemonPaths, type CodegraphDaemonPaths } from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import {
  DAEMON_OP_COMMANDS,
  type DaemonOpCommand,
} from "../../../../../src/core/adapters/duckdb/daemon/op-commands.js";
import {
  DAEMON_OPS,
  decodeFrames,
  encodeFrame,
  type DaemonHandshakeResult,
  type DaemonOp,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { CodegraphDaemonServer } from "../../../../../src/core/adapters/duckdb/daemon/server.js";
import { CodegraphDaemonBuildSkewError } from "../../../../../src/core/adapters/duckdb/errors.js";
import { GraphDbClientPool, type CollectionInitHook } from "../../../../../src/core/adapters/duckdb/pool.js";
import { InfraError } from "../../../../../src/core/adapters/errors.js";
import {
  createDatabaseMigrationApplier,
  DATABASE_MIGRATIONS_MODULE_URL,
} from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let root: string | undefined;
const daemons: (() => Promise<void>)[] = [];
const pools: GraphDbClientPool[] = [];
let fakeSrv: Server | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  // Pools first: a test failing before its own closeAll would otherwise keep
  // sockets open and hang the server close below.
  for (const pool of pools.splice(0)) await pool.closeAll().catch(() => undefined);
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
  root = undefined;
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "cg-caps-"));
  return root;
}

function makePaths(): CodegraphDaemonPaths {
  const paths = getDaemonPaths(join(makeRoot(), "d"));
  mkdirSync(paths.storageDir, { recursive: true });
  return paths;
}

/** The real op table minus `ops` — a daemon from a build that never had them. */
function withoutOps(...ops: DaemonOp[]): Partial<Record<DaemonOp, DaemonOpCommand>> {
  return Object.fromEntries(
    Object.entries(DAEMON_OP_COMMANDS).filter(([op]) => !ops.includes(op as DaemonOp)),
  ) as Partial<Record<DaemonOp, DaemonOpCommand>>;
}

/** Real daemon (socket + server + DuckDB pool) with an injected identity and op table. */
async function startDaemon(
  paths: CodegraphDaemonPaths,
  buildFingerprint: string,
  opCommands?: Partial<Record<DaemonOp, DaemonOpCommand>>,
): Promise<void> {
  const { shutdown } = await runDaemon({
    rootDir: root as string,
    paths,
    buildFingerprint,
    migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
    ...(opCommands ? { opCommands } : {}),
    exit: () => undefined,
  });
  daemons.push(shutdown);
}

function makePool(
  paths: CodegraphDaemonPaths,
  restart: { buildFingerprint: string; respawn?: () => void; pollIntervalMs?: number },
  initHook?: CollectionInitHook,
): GraphDbClientPool {
  const pool = new GraphDbClientPool({
    rootDir: root as string,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    daemonSocketPath: paths.socketPath,
    daemonRestart: restart,
    ...(initHook ? { initHook } : {}),
  });
  pools.push(pool);
  return pool;
}

/** Protocol-level stand-in: `onReq` may return an `Error` to answer `ok: false`. */
async function fakeDaemon(socketPath: string, onReq: (r: DaemonRequest) => unknown): Promise<void> {
  fakeSrv = createServer((sock) => {
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
  fakeSrv.unref();
  const server = fakeSrv;
  await new Promise<void>((res) => {
    server.listen(socketPath, () => {
      res();
    });
  });
}

describe("daemon capability handshake (bd tea-rags-mcp-39xca.4)", () => {
  it("handshake advertises supportedOps read from the op table the server dispatches on", async () => {
    const pool = new GraphDbClientPool({
      rootDir: makeRoot(),
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
    });

    const full = new CodegraphDaemonServer(pool, "fp");
    const res = await full.handle({
      id: 1,
      op: "handshake",
      params: { collection: "code_caps_full_v1", buildFingerprint: "fp" },
    });
    const advertised = (res as { result: DaemonHandshakeResult }).result.supportedOps ?? [];
    expect([...advertised].sort()).toEqual([...DAEMON_OPS].sort());

    const trimmed = new CodegraphDaemonServer(pool, "fp", undefined, withoutOps("listAllPass1Aggregates"));
    const trimmedRes = await trimmed.handle({
      id: 2,
      op: "handshake",
      params: { collection: "code_caps_trim_v1", buildFingerprint: "fp" },
    });
    expect((trimmedRes as { result: DaemonHandshakeResult }).result.supportedOps).not.toContain(
      "listAllPass1Aggregates",
    );
    // What it advertises is what it dispatches: the op is genuinely gone.
    const call = await trimmed.handle({
      id: 3,
      op: "listAllPass1Aggregates",
      params: { collection: "code_caps_trim_v1" },
    });
    expect(call.ok).toBe(false);

    await pool.closeAll();
  });

  it("every protocol op is either required or explicitly tolerated — nothing falls between", () => {
    // Widening the tolerated set is a deliberate decision, so it is pinned here.
    expect([...LEGACY_TOLERATED_OPS].sort()).toEqual([
      "diffSymbolSignals",
      "getFileMetricsBulk",
      "getSymbolLineRangesBulk",
      // The liveness probe (f924y): an older daemon's "unknown op" answer is the proof of life it asks for.
      "ping",
      "refreshSymbolSignalsPrev",
    ]);
    expect(new Set([...REQUIRED_DAEMON_OPS, ...LEGACY_TOLERATED_OPS])).toEqual(new Set(DAEMON_OPS));
    expect(REQUIRED_DAEMON_OPS.filter((op) => LEGACY_TOLERATED_OPS.has(op))).toEqual([]);
    // The weno4 op — its silent degrade is what corrupted a live run.
    expect(REQUIRED_DAEMON_OPS).toContain("listAllPass1Aggregates");
  });

  it("a pool without a respawn hook refuses a daemon lacking a required op, before handing out a handle", async () => {
    const paths = makePaths();
    await startDaemon(paths, "OLD-BUILD", withoutOps("listAllPass1Aggregates"));

    const initHook = vi.fn<CollectionInitHook>(async () => undefined);
    const pool = makePool(paths, { buildFingerprint: "NEW-BUILD" }, initHook);

    const err = await pool.acquireWrite("code_caps_hookless_v1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodegraphDaemonBuildSkewError);
    expect(err).toBeInstanceOf(InfraError);
    expect((err as CodegraphDaemonBuildSkewError).missingOps).toEqual(["listAllPass1Aggregates"]);
    expect((err as CodegraphDaemonBuildSkewError).hint).toMatch(/restart/i);
    expect((err as CodegraphDaemonBuildSkewError).hint).toMatch(/reconnect/i);
    // No handle, so no run work: the symbol-table hydration never ran.
    expect(initHook).not.toHaveBeenCalled();
    // Draining the daemon is the respawn-capable pool's job — this one left it alone.
    expect(existsSync(paths.pidFile)).toBe(true);

    await pool.closeAll();
  });

  it("a pool without a respawn hook refuses a daemon that predates supportedOps and runs another build", async () => {
    const paths = makePaths();
    // A daemon from the fingerprint era but before capability advertisement.
    await fakeDaemon(paths.socketPath, (r) => (r.op === "handshake" ? { buildFingerprint: "OLD-BUILD" } : null));

    const pool = makePool(paths, { buildFingerprint: "NEW-BUILD" });

    const err = await pool.acquireWrite("code_caps_predates_v1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodegraphDaemonBuildSkewError);
    // Nothing to name: the daemon never said what it supports.
    expect((err as CodegraphDaemonBuildSkewError).missingOps).toEqual([]);
    expect((err as CodegraphDaemonBuildSkewError).message).toMatch(/OLD-BUILD/);

    await pool.closeAll();
  });

  it("a pool WITH a respawn hook replaces a daemon lacking a required op, even at a matching build fingerprint", async () => {
    const paths = makePaths();
    await startDaemon(paths, "SAME-BUILD", withoutOps("listAllPass1Aggregates"));

    let respawns = 0;
    const pool = makePool(paths, {
      buildFingerprint: "SAME-BUILD",
      pollIntervalMs: 20,
      respawn: () => {
        respawns++;
        void startDaemon(paths, "SAME-BUILD");
      },
    });

    const handle = await pool.acquireWrite("code_caps_hooked_v1");
    expect(respawns).toBe(1);
    // The op is live on the replacement — a real round-trip, not merely a connect.
    await expect(handle.graphDb.listAllPass1Aggregates()).resolves.toEqual([]);

    await pool.closeAll();
  });

  it("a tolerated op the daemon lacks answers its neutral result and warns once for that op", async () => {
    const dir = makeRoot();
    const socketPath = join(dir, "d.sock");
    await fakeDaemon(socketPath, (r) =>
      r.op === "diffSymbolSignals" ? new Error("unknown daemon op: diffSymbolSignals") : null,
    );
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const client = new DaemonGraphDbClient(socketPath, "code_caps_tolerated_v1");
    await client.init();
    await expect(client.diffSymbolSignals()).resolves.toEqual({ symbols: [], files: [] });
    await expect(client.diffSymbolSignals()).resolves.toEqual({ symbols: [], files: [] });
    await client.close();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(line).toMatch(/diffSymbolSignals/);
    expect(line).toMatch(/older build/i);
  });

  it("an op outside the tolerated set that the daemon lacks throws the typed skew error", async () => {
    const dir = makeRoot();
    const socketPath = join(dir, "d.sock");
    await fakeDaemon(socketPath, (r) =>
      r.op === "listAllPass1Aggregates" ? new Error("unknown daemon op: listAllPass1Aggregates") : null,
    );

    const client = new DaemonGraphDbClient(socketPath, "code_caps_required_v1");
    await client.init();
    const err = await client.listAllPass1Aggregates().catch((e: unknown) => e);
    await client.close();

    expect(err).toBeInstanceOf(CodegraphDaemonBuildSkewError);
    expect((err as CodegraphDaemonBuildSkewError).missingOps).toEqual(["listAllPass1Aggregates"]);
    expect((err as CodegraphDaemonBuildSkewError).cause?.message).toMatch(/unknown daemon op/);
  });
});
