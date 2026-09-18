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

import { DaemonGraphDbClient, REQUIRED_DAEMON_OPS } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { CodegraphDaemonBuildSkewError } from "../../../../../src/core/adapters/duckdb/errors.js";

let dir: string;
const servers: Server[] = [];
const clients: DaemonGraphDbClient[] = [];
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
