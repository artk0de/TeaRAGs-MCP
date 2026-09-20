/**
 * Shutdown-drain guard (bd tea-rags-mcp-zgcmo).
 *
 * A client-requested `shutdown` drain used to be ACKed unconditionally, so a
 * drain from a foreign build (`npm link` re-pointed at another checkout,
 * `npm i -g` over an active link) killed the daemon while OTHER sessions'
 * connections had writes in flight — their worker-thread pools rejected with
 * "daemon connection failed: write EPIPE" and the in-flight codegraph runs
 * died. The daemon now reads its own write bookkeeping and REFUSES such a
 * drain: the draining side gets a typed stale-build-family error and owns the
 * retry/defer decision; the live writers finish untouched. With no writes in
 * flight the drain proceeds exactly as before.
 *
 * Coverage: the transport-level guard over a real socket with two connections,
 * the in-flight-write detection unit, and the pool-side settle (the draining
 * pool must surface the refusal as the typed error instead of waiting out a
 * daemon exit that will never start).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConnectionHandler } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { getDaemonPaths, type CodegraphDaemonPaths } from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
  type DaemonResponse,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { CodegraphDaemonServer } from "../../../../../src/core/adapters/duckdb/daemon/server.js";
import {
  CodegraphDaemonDrainRefusedError,
  CodegraphDaemonExitTimeoutError,
  isCodegraphUnavailableError,
} from "../../../../../src/core/adapters/duckdb/errors.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { createDatabaseMigrationApplier } from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/** A collection name that passes `physicalCollectionNameFromDaemonRequest`. */
const COLLECTION = "code_drain_v1";

let root: string;
const servers: Server[] = [];
const pools: GraphDbClientPool[] = [];
const sockets: { destroy: () => void }[] = [];

afterEach(async () => {
  for (const sock of sockets.splice(0)) sock.destroy();
  for (const srv of servers.splice(0)) {
    await new Promise<void>((res) => {
      srv.close(() => {
        res();
      });
    });
  }
  for (const pool of pools.splice(0)) await pool.closeAll().catch(() => undefined);
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Controllable write: `checkpoint` hangs on this gate while "in flight". */
let releaseWrite!: () => void;

/**
 * A real socket server wired to `createConnectionHandler` over a
 * `CodegraphDaemonServer` whose write path blocks on the write gate — so a
 * write is in flight for exactly as long as the test holds the gate shut.
 */
async function startDrainHarness(): Promise<{
  server: CodegraphDaemonServer;
  onShutdownRequest: ReturnType<typeof vi.fn>;
  client: () => Promise<{ send: (op: "checkpoint" | "shutdown") => Promise<DaemonResponse>; close: () => void }>;
}> {
  root = mkdtempSync(join(tmpdir(), "cg-drain-"));
  const paths: CodegraphDaemonPaths = getDaemonPaths(join(root, "d"));
  mkdirSync(paths.storageDir, { recursive: true });

  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const fakeGraphDb = { checkpoint: async () => writeGate };
  const fakePool = {
    acquire: async () => ({ graphDb: fakeGraphDb, symbolTable: new InMemoryGlobalSymbolTable() }),
  };
  const server = new CodegraphDaemonServer(fakePool as never, "TEST-BUILD");
  const onShutdownRequest = vi.fn();

  const srv = createServer(createConnectionHandler(server, paths, onShutdownRequest));
  servers.push(srv);
  await new Promise<void>((res) => {
    srv.listen(paths.socketPath, () => {
      res();
    });
  });

  const client = async (): Promise<{
    send: (op: "checkpoint" | "shutdown") => Promise<DaemonResponse>;
    close: () => void;
  }> => {
    return new Promise((resolve) => {
      const sock = connect(paths.socketPath);
      sockets.push(sock);
      const pending = new Map<number, (res: DaemonResponse) => void>();
      let buf = "";
      let nextId = 1;
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const f of frames) {
          const res = JSON.parse(f) as DaemonResponse;
          const settle = pending.get(res.id);
          if (!settle) continue;
          pending.delete(res.id);
          settle(res);
        }
      });
      sock.on("connect", () => {
        resolve({
          send: async (op) =>
            new Promise((res) => {
              const id = nextId++;
              pending.set(id, res);
              const req = { id, op, params: { collection: COLLECTION } } as DaemonRequest;
              sock.write(encodeFrame(req));
            }),
          close: (): void => {
            sock.destroy();
          },
        });
      });
    });
  };

  return { server, onShutdownRequest, client };
}

describe("shutdown-drain guard — refuse a drain while another connection writes (zgcmo)", () => {
  it("refuses a drain requested while another connection has a write in flight, and the write completes", async () => {
    const harness = await startDrainHarness();
    const writer = await harness.client();
    const drainer = await harness.client();

    // Connection A's write is admitted and running (held on the gate)...
    const writeSettled = writer.send("checkpoint");
    await vi.waitFor(() => {
      expect(harness.server.hasWritesInFlight()).toBe(true);
    });

    // ...so connection B's drain must be refused, not ACKed.
    const drainRes = await drainer.send("shutdown");
    expect(drainRes.ok).toBe(false);
    if (drainRes.ok) throw new Error("expected the drain to be refused");
    expect(drainRes.error.name).toBe("CodegraphDaemonDrainRefusedError");
    expect(drainRes.error.message).toMatch(/writes in flight/i);
    // The drain never started — the daemon stays up for the writers.
    expect(harness.onShutdownRequest).not.toHaveBeenCalled();

    // The writer's operation completes successfully.
    releaseWrite();
    const writeRes = await writeSettled;
    expect(writeRes.ok).toBe(true);
  });

  it("drains normally when no other connection holds writes in flight", async () => {
    const harness = await startDrainHarness();
    const drainer = await harness.client();

    const drainRes = await drainer.send("shutdown");
    expect(drainRes.ok).toBe(true);
    expect(harness.onShutdownRequest).toHaveBeenCalledTimes(1);
  });

  it("proceeds with a drain once the in-flight write has completed", async () => {
    const harness = await startDrainHarness();
    const writer = await harness.client();
    const drainer = await harness.client();

    const writeSettled = writer.send("checkpoint");
    await vi.waitFor(() => {
      expect(harness.server.hasWritesInFlight()).toBe(true);
    });
    releaseWrite();
    expect((await writeSettled).ok).toBe(true);

    // The bookkeeping has settled, so the SAME drain that was refused before
    // the write finished now goes through.
    const drainRes = await drainer.send("shutdown");
    expect(drainRes.ok).toBe(true);
    expect(harness.onShutdownRequest).toHaveBeenCalledTimes(1);
  });
});

describe("in-flight-write detection — existing write bookkeeping read as a guard input", () => {
  it("flips on the start and finish of an admitted write", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-drain-unit-"));
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const fakePool = {
      acquire: async () => ({
        graphDb: { checkpoint: async () => writeGate },
        symbolTable: new InMemoryGlobalSymbolTable(),
      }),
    };
    const server = new CodegraphDaemonServer(fakePool as never, "TEST-BUILD");
    expect(server.hasWritesInFlight()).toBe(false);

    // admitWrite registers the tail synchronously on dispatch, so the flag is
    // up the moment handle() is called — the write is queued-or-running.
    const pending = server.handle({ id: 1, op: "checkpoint", params: { collection: COLLECTION } });
    expect(server.hasWritesInFlight()).toBe(true);

    releaseWrite();
    expect((await pending).ok).toBe(true);
    expect(server.hasWritesInFlight()).toBe(false);
  });
});

describe("draining pool settles a refused drain with the typed error", () => {
  function makePaths(): CodegraphDaemonPaths {
    root = mkdtempSync(join(tmpdir(), "cg-drain-pool-"));
    const paths = getDaemonPaths(join(root, "d"));
    mkdirSync(paths.storageDir, { recursive: true });
    return paths;
  }

  function makePool(paths: CodegraphDaemonPaths, respawn: () => void, exitTimeoutMs?: number): GraphDbClientPool {
    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
      daemonSocketPath: paths.socketPath,
      daemonRestart: { buildFingerprint: "NEW-BUILD", respawn, exitTimeoutMs, pollIntervalMs: 20 },
    });
    pools.push(pool);
    return pool;
  }

  function fakeDaemon(paths: CodegraphDaemonPaths, shutdownResponse: DaemonResponse): void {
    const srv = createServer((sock) => {
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const f of frames) {
          const req = JSON.parse(f) as DaemonRequest;
          const res: DaemonResponse =
            req.op === "handshake"
              ? { id: req.id, ok: true, result: { buildFingerprint: "WEDGED-OLD" } }
              : { ...shutdownResponse, id: req.id };
          sock.write(encodeFrame(res));
        }
      });
    });
    servers.push(srv);
    srv.unref();
    void new Promise<void>((res) => {
      srv.listen(paths.socketPath, () => {
        res();
      });
    });
  }

  it("surfaces the daemon's refusal as CodegraphDaemonDrainRefusedError instead of waiting for an exit that never starts", async () => {
    const paths = makePaths();
    fakeDaemon(paths, {
      id: 0,
      ok: false,
      error: { name: "CodegraphDaemonDrainRefusedError", message: "refused on the wire" },
    });

    const respawn = vi.fn();
    const pool = makePool(paths, () => respawn(), 250);

    const err = await pool.acquireWrite(COLLECTION).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodegraphDaemonDrainRefusedError);
    // The refusal means the daemon is HEALTHY and busy — an acquire failure a
    // consumer may degrade on, so it belongs to the unavailable family.
    expect(isCodegraphUnavailableError(err)).toBe(true);
    // The retry/defer decision stays with the caller — no respawn on a daemon
    // that never agreed to drain.
    expect(respawn).not.toHaveBeenCalled();
  });

  it("keeps the swallow-and-poll path for any other shutdown failure (only the refusal short-circuits)", async () => {
    const paths = makePaths();
    fakeDaemon(paths, { id: 0, ok: false, error: { name: "SomethingElseError", message: "not a refusal" } });
    // A live pid — the fake daemon "keeps running" through the exit wait.
    writeFileSync(paths.pidFile, String(process.pid), "utf-8");

    const respawn = vi.fn();
    const pool = makePool(paths, () => respawn(), 250);

    await expect(pool.acquireWrite(COLLECTION)).rejects.toThrow(CodegraphDaemonExitTimeoutError);
    expect(respawn).not.toHaveBeenCalled();
  });
});
