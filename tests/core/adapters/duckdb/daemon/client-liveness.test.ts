/**
 * A pending daemon call is bounded by the daemon's liveness, not by the op's
 * duration (bd tea-rags-mcp-f924y).
 *
 * `DaemonGraphDbClient#call` sets no timeout, and must not: a cycles/PageRank
 * pass legitimately runs for minutes. But a daemon that is alive and wedged —
 * or one whose connection went silent without closing — left the caller waiting
 * forever (an index worker at 0.6% CPU for 12+ minutes). While calls are
 * pending, the client probes the daemon; any bytes back, a probe answer or a
 * slice of a large response, prove it alive. Silence past the liveness bound
 * fails every pending call with `CodegraphDaemonUnresponsiveError`.
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
import { CodegraphDaemonServer } from "../../../../../src/core/adapters/duckdb/daemon/server.js";
import {
  CodegraphDaemonUnresponsiveError,
  isCodegraphUnavailableError,
} from "../../../../../src/core/adapters/duckdb/errors.js";
import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";

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

/**
 * A stand-in daemon. `answer` returns `{ result, afterMs? }` to reply (late when
 * `afterMs` is set) or `"silent"` to never reply. Records every op it receives.
 */
async function daemon(
  answer: (r: DaemonRequest) => { result?: unknown; error?: string; afterMs?: number } | "silent",
): Promise<{ socketPath: string; received: string[] }> {
  dir = mkdtempSync(join(tmpdir(), "cg-liveness-"));
  const socketPath = join(dir, "cg.sock");
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
        const reply = answer(req);
        if (reply === "silent") continue;
        const response =
          reply.error === undefined
            ? { id: req.id, ok: true as const, result: reply.result }
            : { id: req.id, ok: false as const, error: { name: "Error", message: reply.error } };
        const write = (): void => {
          if (!sock.destroyed) sock.write(encodeFrame(response));
        };
        if (reply.afterMs === undefined) write();
        else setTimeout(write, reply.afterMs);
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
  return { socketPath, received };
}

function client(socketPath: string): DaemonGraphDbClient {
  const c = new DaemonGraphDbClient(socketPath, "code_x", {
    retryDelayMs: 5,
    connectTimeoutMs: 2000,
    livenessProbeIntervalMs: 20,
    livenessTimeoutMs: 300,
  });
  clients.push(c);
  return c;
}

describe("DaemonGraphDbClient — liveness of a pending call (f924y)", () => {
  it("fails a pending call with a typed error once the daemon stops answering altogether", async () => {
    const { socketPath } = await daemon(() => "silent");
    const c = client(socketPath);
    await c.init();

    const failure = await c.hasData().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CodegraphDaemonUnresponsiveError);
    // An optional codegraph read (find_symbol's hop) degrades on it like any unreachable daemon.
    expect(isCodegraphUnavailableError(failure)).toBe(true);
  }, 15_000);

  it("keeps a call alive past the bound while the daemon answers its probes", async () => {
    const { socketPath, received } = await daemon((r) =>
      r.op === "ping" ? { result: null } : { result: true, afterMs: 900 },
    );
    const c = client(socketPath);
    await c.init();

    await expect(c.hasData()).resolves.toBe(true);
    expect(received.filter((op) => op === "ping").length).toBeGreaterThan(0);
  }, 15_000);

  it("counts any answer to a probe as life — even a daemon that predates the probe op", async () => {
    // What a daemon from before the probe op answers: the dispatcher's unknown-op error.
    const { socketPath } = await daemon((r) =>
      r.op === "ping" ? { error: "unknown daemon op: ping" } : { result: true, afterMs: 900 },
    );
    const c = client(socketPath);
    await c.init();

    await expect(c.hasData()).resolves.toBe(true);
  }, 15_000);

  it("probes nothing while no call is pending", async () => {
    const { socketPath, received } = await daemon(() => ({ result: true }));
    const c = client(socketPath);
    await c.init();
    await c.hasData();
    const afterCall = received.length;

    await new Promise((res) => setTimeout(res, 200));

    expect(received.length).toBe(afterCall);
  }, 15_000);
});

describe("CodegraphDaemonServer — the liveness probe op (f924y)", () => {
  it("answers ping without touching a collection", async () => {
    const pool = {
      acquire: async () => {
        throw new Error("ping must not open a collection");
      },
    } as unknown as GraphDbClientPool;
    const server = new CodegraphDaemonServer(pool, "fp-test");

    await expect(
      server.handle({ id: 1, op: "ping", params: { collection: "code_x" } } as unknown as DaemonRequest),
    ).resolves.toEqual({ id: 1, ok: true, result: null });
  });
});
