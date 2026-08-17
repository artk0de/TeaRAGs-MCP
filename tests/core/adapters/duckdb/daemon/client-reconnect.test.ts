/**
 * bd tea-rags-mcp-8l8d3 — surviving a daemon that dies mid-request.
 *
 * The codegraph daemon holds the sole RW handle on every collection's DuckDB
 * file, so when it dies every client waiting on it dies with it. On 2026-08-17
 * a DuckDB `FatalException` aborted the daemon nine times during one taxdome
 * `--force-enrichments codegraph` run. That abort reaches the process as
 * `libc++abi: terminating` — SIGABRT, from native code, catchable by nothing on
 * the JavaScript side — so "make the daemon not throw" is not a fix that exists
 * for this class of failure. `CodegraphDaemonServer#handle` already converts
 * every JS-level throw into an `{ ok: false }` response; a native abort simply
 * never becomes a JS throw.
 *
 * What CAN hold is the client side: a dropped connection is recoverable state,
 * not a terminal one. Every op this client proxies is idempotent — file writes
 * reconcile a scope, symbol writes replace a file's rows, checkpoints and
 * metric rebuilds are recomputes — so a request that was in flight when the
 * socket dropped can be re-sent against a fresh daemon. The retry is bounded to
 * one attempt per request so a daemon that dies on every call fails loudly
 * instead of looping.
 */
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DaemonGraphDbClient } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";

let dir: string;
const servers: Server[] = [];
const clients: DaemonGraphDbClient[] = [];
/** Accepted sockets per server — `net.Server#close` waits on them otherwise. */
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

/** Register a client for teardown so its socket cannot outlive the test. */
function track(client: DaemonGraphDbClient): DaemonGraphDbClient {
  clients.push(client);
  return client;
}

/**
 * A stand-in daemon. `answer` returns the op result, or `"die"` to drop the
 * connection without responding — the observable shape of a native abort.
 */
async function daemon(socketPath: string, answer: (r: DaemonRequest) => unknown): Promise<Server> {
  if (existsSync(socketPath)) unlinkSync(socketPath);
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
  return srv;
}

function tempSocket(): string {
  dir = mkdtempSync(join(tmpdir(), "cg-daemon-reconnect-"));
  return join(dir, "cg.sock");
}

describe("DaemonGraphDbClient — daemon death mid-request", () => {
  it("respawns and retries the in-flight request when the daemon drops the connection", async () => {
    const socketPath = tempSocket();
    const dying = await daemon(socketPath, () => "die");

    let respawns = 0;
    const client = track(
      new DaemonGraphDbClient(socketPath, "code_x", {
        retryDelayMs: 5,
        connectTimeoutMs: 2000,
        onConnectionLost: async () => {
          respawns += 1;
          await shutdown(dying);
          await daemon(socketPath, () => true);
        },
      }),
    );
    await client.init();

    await expect(client.hasData()).resolves.toBe(true);
    expect(respawns).toBe(1);
  });

  it("retries a request at most once — a daemon that keeps dying fails loudly", async () => {
    const socketPath = tempSocket();
    let current = await daemon(socketPath, () => "die");

    let respawns = 0;
    const client = track(
      new DaemonGraphDbClient(socketPath, "code_x", {
        retryDelayMs: 5,
        connectTimeoutMs: 2000,
        onConnectionLost: async () => {
          respawns += 1;
          await shutdown(current);
          current = await daemon(socketPath, () => "die");
        },
      }),
    );
    await client.init();

    await expect(client.hasData()).rejects.toThrow(/daemon closed the connection/);
    expect(respawns).toBe(1);
  });

  it("rejects as before when no respawn hook is wired", async () => {
    const socketPath = tempSocket();
    await daemon(socketPath, () => "die");

    const client = track(new DaemonGraphDbClient(socketPath, "code_x", { retryDelayMs: 5, connectTimeoutMs: 300 }));
    await client.init();

    await expect(client.hasData()).rejects.toThrow(/daemon closed the connection/);
  });

  it("does not respawn when the caller closed the client itself", async () => {
    const socketPath = tempSocket();
    await daemon(socketPath, () => true);

    let respawns = 0;
    const client = track(
      new DaemonGraphDbClient(socketPath, "code_x", {
        retryDelayMs: 5,
        onConnectionLost: () => {
          respawns += 1;
        },
      }),
    );
    await client.init();
    await expect(client.hasData()).resolves.toBe(true);
    await client.close();
    await new Promise((res) => setTimeout(res, 50));

    expect(respawns).toBe(0);
    expect(client.isConnected()).toBe(false);
  });
});
