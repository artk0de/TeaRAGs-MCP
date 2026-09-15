/**
 * Run-start daemon guard ordering (bd tea-rags-mcp-39xca.4).
 *
 * Worker-thread codegraph pools have no respawn hook: meeting a daemon from an
 * older build they can only refuse it. The respawn-capable handshake lives in
 * the MAIN thread's pool, so it has to reach the daemon before any worker does.
 * The run-start keep-alive guard is the first thing an index run points at the
 * daemon — it must run that handshake before it holds its keep-alive socket.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createIndexRunDaemonGuard } from "../../src/bootstrap/factory.js";

let dir: string | undefined;
let srv: Server | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((res) => {
    if (srv) {
      srv.close(() => {
        res();
      });
    } else {
      res();
    }
  });
  srv = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("createIndexRunDaemonGuard", () => {
  it("runs the respawn-capable build handshake before the run holds its keep-alive socket", async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-guard-"));
    const socketPath = join(dir, "d.sock");
    let connections = 0;
    srv = createServer((sock) => {
      connections++;
      sock.on("error", () => {
        sock.destroy();
      });
    });
    srv.unref();
    const server = srv;
    await new Promise<void>((res) => {
      server.listen(socketPath, () => {
        res();
      });
    });

    const order: string[] = [];
    const guard = createIndexRunDaemonGuard({
      socketPath,
      ensure: () => {
        order.push("ensure");
      },
      verifyDaemonBuild: async (collectionName) => {
        order.push(`verify ${collectionName} with ${connections} keep-alive socket(s)`);
      },
    });

    const release = await guard.begin("code_guard_v1");
    expect(order).toEqual(["ensure", "verify code_guard_v1 with 0 keep-alive socket(s)"]);
    await vi.waitFor(() => {
      expect(connections).toBe(1);
    });
    await release();
  });

  it("never rejects: a refused build handshake is logged and hands back a no-op release", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const guard = createIndexRunDaemonGuard({
      socketPath: "/nonexistent/codegraph-daemon.sock",
      ensure: () => undefined,
      verifyDaemonBuild: async () => {
        throw new Error("daemon build skew");
      },
    });

    const release = await guard.begin("code_guard_skew_v1");
    await expect(release()).resolves.toBeUndefined();
    const logged = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toMatch(/keep-alive failed for code_guard_skew_v1: daemon build skew/);
  });
});
