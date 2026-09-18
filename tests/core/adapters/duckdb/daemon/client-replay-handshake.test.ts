/**
 * A request replayed after the daemon died goes only to a replacement this
 * client has handshaken with (bd tea-rags-mcp-f924y).
 *
 * `reconnectAndReplay` (bd tea-rags-mcp-8l8d3) re-sends in-flight requests to
 * whatever daemon answers the socket next. When the death was a drain by
 * another session's build handshake, that replacement runs ANOTHER build — and
 * the replay used to land on it unverified: an op it no longer knows fails as
 * unknown, an op whose payload shape moved is misread silently. The replay path
 * now runs the same build + capability handshake a fresh connection runs, and
 * applies the bar a pool without a respawn hook applies (39xca.4): a daemon that
 * lacks a required op, or is too old to say what it serves, gets no replay.
 */
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { DaemonGraphDbClient, REQUIRED_DAEMON_OPS } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import {
  CodegraphClientStaleBuildError,
  CodegraphDaemonBuildSkewError,
  isCodegraphUnavailableError,
} from "../../../../../src/core/adapters/duckdb/errors.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { createDatabaseMigrationApplier } from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let dir: string;
const servers: Server[] = [];
const clients: DaemonGraphDbClient[] = [];
const pools: GraphDbClientPool[] = [];
const accepted = new Map<Server, Socket[]>();

async function shutdown(srv: Server): Promise<void> {
  for (const s of accepted.get(srv) ?? []) s.destroy();
  accepted.delete(srv);
  await new Promise<void>((res) => {
    srv.close(() => {
      res();
    });
  });
}

afterEach(async () => {
  for (const p of pools.splice(0)) await p.closeAll().catch(() => undefined);
  for (const c of clients.splice(0)) await c.close();
  for (const s of servers.splice(0)) await shutdown(s);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function track(client: DaemonGraphDbClient): DaemonGraphDbClient {
  clients.push(client);
  return client;
}

/** A stand-in daemon recording the ops it receives; `"die"` drops the connection. */
async function daemon(
  socketPath: string,
  answer: (r: DaemonRequest) => unknown,
): Promise<{ server: Server; received: string[] }> {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const received: string[] = [];
  const srv = createServer((sock) => {
    accepted.set(srv, [...(accepted.get(srv) ?? []), sock]);
    let buf = "";
    sock.on("error", () => undefined);
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        const req = JSON.parse(f) as DaemonRequest;
        received.push(req.op);
        const result = answer(req);
        if (result === "die") {
          sock.destroy();
          return;
        }
        sock.write(encodeFrame({ id: req.id, ok: true, result }));
      }
    });
  });
  srv.unref();
  servers.push(srv);
  await new Promise<void>((res) => {
    srv.listen(socketPath, () => {
      res();
    });
  });
  return { server: srv, received };
}

function tempSocket(): string {
  dir = mkdtempSync(join(tmpdir(), "cg-replay-handshake-"));
  return join(dir, "cg.sock");
}

const FULL_OPS = [...REQUIRED_DAEMON_OPS];

/** First daemon: handshakes as build A, then dies on the first real request. */
function dyingAfterHandshake(r: DaemonRequest): unknown {
  return r.op === "handshake" ? { buildFingerprint: "fp-A", supportedOps: FULL_OPS } : "die";
}

describe("DaemonGraphDbClient — replay only after a handshake with the replacement (f924y)", () => {
  it("handshakes the replacement daemon before replaying onto it", async () => {
    const socketPath = tempSocket();
    const first = await daemon(socketPath, dyingAfterHandshake);
    let replacement: { received: string[] } | undefined;
    const client = track(
      new DaemonGraphDbClient(socketPath, "code_x", {
        retryDelayMs: 5,
        connectTimeoutMs: 2000,
        onConnectionLost: async () => {
          await shutdown(first.server);
          replacement = await daemon(socketPath, (r) =>
            r.op === "handshake" ? { buildFingerprint: "fp-A", supportedOps: FULL_OPS } : true,
          );
        },
      }),
    );
    await client.init();
    await client.handshake("fp-A");

    await expect(client.hasData()).resolves.toBe(true);
    expect(replacement?.received).toEqual(["handshake", "hasData"]);
  });

  it("rejects the pending request with a typed build-skew error when the replacement lacks a required op", async () => {
    const socketPath = tempSocket();
    const first = await daemon(socketPath, dyingAfterHandshake);
    let replacement: { received: string[] } | undefined;
    const client = track(
      new DaemonGraphDbClient(socketPath, "code_x", {
        retryDelayMs: 5,
        connectTimeoutMs: 2000,
        onConnectionLost: async () => {
          await shutdown(first.server);
          replacement = await daemon(socketPath, (r) =>
            r.op === "handshake"
              ? { buildFingerprint: "fp-B", supportedOps: FULL_OPS.filter((op) => op !== "hasData") }
              : true,
          );
        },
      }),
    );
    await client.init();
    await client.handshake("fp-A");

    await expect(client.hasData()).rejects.toBeInstanceOf(CodegraphDaemonBuildSkewError);
    expect(replacement?.received).toEqual(["handshake"]);
  });

  it("replays onto another build that still serves every required op, as a pool without a respawn hook would", async () => {
    const socketPath = tempSocket();
    const first = await daemon(socketPath, dyingAfterHandshake);
    const client = track(
      new DaemonGraphDbClient(socketPath, "code_x", {
        retryDelayMs: 5,
        connectTimeoutMs: 2000,
        onConnectionLost: async () => {
          await shutdown(first.server);
          await daemon(socketPath, (r) =>
            r.op === "handshake" ? { buildFingerprint: "fp-B", supportedOps: FULL_OPS } : true,
          );
        },
      }),
    );
    await client.init();
    await client.handshake("fp-A");

    await expect(client.hasData()).resolves.toBe(true);
  });

  it("fails the pending request instead of hanging when the replacement dies during the handshake", async () => {
    const socketPath = tempSocket();
    const first = await daemon(socketPath, dyingAfterHandshake);
    const client = track(
      new DaemonGraphDbClient(socketPath, "code_x", {
        retryDelayMs: 5,
        connectTimeoutMs: 2000,
        onConnectionLost: async () => {
          await shutdown(first.server);
          await daemon(socketPath, () => "die");
        },
      }),
    );
    await client.init();
    await client.handshake("fp-A");

    await expect(client.hasData()).rejects.toThrow(/could not be recovered/);
  }, 15_000);
});

/**
 * A refused replacement must not keep the connection (bd tea-rags-mcp-f924y).
 * The replay path may not drain or respawn — that decision belongs to the
 * pool's build handshake, which runs only for a client that is not connected.
 * A refusal that left the socket open kept the pool handing back the same
 * client forever, and its open connection held the refused daemon alive
 * against its idle exit.
 */
describe("DaemonGraphDbClient — a refused replay releases the connection (f924y)", () => {
  it("reports itself disconnected after refusing the replacement daemon", async () => {
    const socketPath = tempSocket();
    const first = await daemon(socketPath, dyingAfterHandshake);
    let replacementConnections = 0;
    const client = track(
      new DaemonGraphDbClient(socketPath, "code_x", {
        retryDelayMs: 5,
        connectTimeoutMs: 2000,
        onConnectionLost: async () => {
          await shutdown(first.server);
          const replacement = await daemon(socketPath, (r) =>
            r.op === "handshake"
              ? { buildFingerprint: "fp-B", supportedOps: FULL_OPS.filter((op) => op !== "hasData") }
              : true,
          );
          replacement.server.on("connection", (sock) => {
            replacementConnections++;
            sock.on("close", () => {
              replacementConnections--;
            });
          });
        },
      }),
    );
    await client.init();
    await client.handshake("fp-A");

    await expect(client.hasData()).rejects.toBeInstanceOf(CodegraphDaemonBuildSkewError);
    expect(client.isConnected()).toBe(false);
    // The refused daemon sees the connection close — nothing holds it open.
    await expect.poll(() => replacementConnections, { timeout: 2000 }).toBe(0);
  });

  // Which side a refusal blames (bd tea-rags-mcp-1wr7p): the replacement runs
  // the build on disk NOW, so when that is not this client's build, THIS
  // process is the stale peer — "the daemon runs an older build" would send the
  // operator after the wrong process.
  it.each([
    {
      side: "the client, when the replacement runs the build on disk this process predates",
      onDisk: "fp-B",
      expected: CodegraphClientStaleBuildError,
    },
    {
      side: "the daemon, when the replacement is not the build on disk",
      onDisk: "fp-A",
      expected: CodegraphDaemonBuildSkewError,
    },
  ])("names the stale side of a refused replay: $side", async ({ onDisk, expected }) => {
    const socketPath = tempSocket();
    const first = await daemon(socketPath, dyingAfterHandshake);
    const client = track(
      new DaemonGraphDbClient(socketPath, "code_x", {
        retryDelayMs: 5,
        connectTimeoutMs: 2000,
        readOnDiskBuildFingerprint: () => onDisk,
        onConnectionLost: async () => {
          await shutdown(first.server);
          await daemon(socketPath, (r) =>
            r.op === "handshake"
              ? { buildFingerprint: "fp-B", supportedOps: FULL_OPS.filter((op) => op !== "hasData") }
              : true,
          );
        },
      }),
    );
    await client.init();
    await client.handshake("fp-A");

    const err = await client.hasData().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(expected);
    expect(isCodegraphUnavailableError(err)).toBe(true);
    expect((err as { missingOps: readonly string[] }).missingOps).toEqual(["hasData"]);
    expect(client.isConnected()).toBe(false);
  });

  // bd tea-rags-mcp-1wr7p: the common way a long-lived process meets a newer
  // daemon is exactly this — its daemon went away and the respawn launched the
  // rebuilt tree. The replay settles it the way the pool's handshake does:
  // proceed, read-only.
  it("replays only the reads when the replacement runs the build on disk this process predates", async () => {
    const socketPath = tempSocket();
    const first = await daemon(socketPath, dyingAfterHandshake);
    let replacement: { received: string[] } | undefined;
    const client = track(
      new DaemonGraphDbClient(socketPath, "code_x", {
        retryDelayMs: 5,
        connectTimeoutMs: 2000,
        readOnDiskBuildFingerprint: () => "fp-B",
        onConnectionLost: async () => {
          await shutdown(first.server);
          replacement = await daemon(socketPath, (r) =>
            r.op === "handshake" ? { buildFingerprint: "fp-B", supportedOps: FULL_OPS } : true,
          );
        },
      }),
    );
    await client.init();
    await client.handshake("fp-A");

    const write = client.checkpoint().catch((e: unknown) => e);
    const read = client.hasData();

    expect(await write).toBeInstanceOf(CodegraphClientStaleBuildError);
    await expect(read).resolves.toBe(true);
    expect(replacement?.received).toEqual(["handshake", "hasData"]);
    // From here on the client stays read-only.
    await expect(client.checkpoint()).rejects.toBeInstanceOf(CodegraphClientStaleBuildError);
    await expect(client.hasData()).resolves.toBe(true);
    expect(replacement?.received).toEqual(["handshake", "hasData", "hasData"]);
  });

  it("the pool runs the build handshake again on the next acquire instead of reusing the refused client", async () => {
    const socketPath = tempSocket();
    const d1 = await daemon(socketPath, dyingAfterHandshake);
    // Each respawn retires the daemon currently listening and brings up the next.
    const next: ((r: DaemonRequest) => unknown)[] = [
      // Replacement the replay meets: another build without `hasData` — refused.
      (r) =>
        r.op === "handshake"
          ? { buildFingerprint: "fp-B", supportedOps: FULL_OPS.filter((op) => op !== "hasData") }
          : true,
      // What the next acquire's handshake meets: this client's own build.
      (r) => (r.op === "handshake" ? { buildFingerprint: "fp-A", supportedOps: FULL_OPS } : true),
    ];
    const started: { server: Server; received: string[] }[] = [d1];
    const swapDaemon = async (): Promise<void> => {
      const answer = next.shift();
      if (!answer) return;
      // `shutdown` stops the listener synchronously; the client's connect
      // retries until the next daemon listens.
      await shutdown((started.at(-1) as { server: Server }).server);
      started.push(await daemon(socketPath, answer));
    };
    const pool = new GraphDbClientPool({
      rootDir: dir,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
      daemonSocketPath: socketPath,
      daemonRestart: {
        buildFingerprint: "fp-A",
        readOnDiskBuildFingerprint: () => undefined,
        respawn: () => {
          void swapDaemon();
        },
      },
    });
    pools.push(pool);
    const collection = fixturePhysicalCollectionName("code_x");

    const handle = await pool.acquireWrite(collection);
    await expect(handle.graphDb.hasData()).rejects.toBeInstanceOf(CodegraphDaemonBuildSkewError);

    const again = await pool.acquireWrite(collection);
    await expect(again.graphDb.hasData()).resolves.toBe(true);
    expect(started).toHaveLength(3);
    expect(started[2]?.received).toEqual(["handshake", "hasData"]);
  });
});
