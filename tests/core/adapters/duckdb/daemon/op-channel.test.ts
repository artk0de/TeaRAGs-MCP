import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { DaemonOpChannel } from "../../../../../src/core/adapters/duckdb/daemon/op-channel.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { CodegraphClientStaleBuildError } from "../../../../../src/core/adapters/duckdb/errors.js";

let dir: string | undefined;
let srv: Server | undefined;

afterEach(async () => {
  const server = srv;
  srv = undefined;
  if (server) {
    await new Promise<void>((res) => {
      server.close(() => {
        res();
      });
    });
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A daemon stand-in: `onReq` answers a request; returning an `Error` answers `ok: false`. */
async function daemonStandIn(onReq: (r: DaemonRequest) => unknown): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), "cg-opch-"));
  const socketPath = join(dir, "d.sock");
  srv = createServer((sock) => {
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
  srv.unref();
  const server = srv;
  await new Promise<void>((res) => {
    server.listen(socketPath, () => {
      res();
    });
  });
  return socketPath;
}

describe("DaemonOpChannel", () => {
  it("sends one op with the injected collection and resolves the daemon's result", async () => {
    const seen: DaemonRequest[] = [];
    const socketPath = await daemonStandIn((r) => {
      seen.push(r);
      return 7;
    });
    const channel = new DaemonOpChannel(socketPath, fixturePhysicalCollectionName("code_x_v1"));
    await channel.init();
    expect(channel.isConnected()).toBe(true);

    expect(await channel.call("getFanIn", { relPath: "a.ts" })).toBe(7);
    await channel.close();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.op).toBe("getFanIn");
    expect(seen[0]?.params).toMatchObject({ relPath: "a.ts", collection: "code_x_v1" });
    expect(channel.isConnected()).toBe(false);
  });

  it("answers a tolerated op from the fallback when the daemon predates it", async () => {
    const socketPath = await daemonStandIn((r) =>
      r.op === "compactStorage" ? new Error(`unknown daemon op: ${r.op}`) : null,
    );
    const channel = new DaemonOpChannel(socketPath, fixturePhysicalCollectionName("code_x_v1"));
    await channel.init();

    const outcome = await channel.callTolerated(
      "compactStorage",
      {},
      () => "decoded",
      () => "fallback",
    );
    await channel.close();

    expect(outcome).toBe("fallback");
  });

  it("handshake sends the fingerprint and requestShutdown sends the shutdown op", async () => {
    const seen: DaemonRequest[] = [];
    const socketPath = await daemonStandIn((r) => {
      seen.push(r);
      return r.op === "handshake" ? { buildFingerprint: "daemon-fp" } : null;
    });
    const channel = new DaemonOpChannel(socketPath, fixturePhysicalCollectionName("code_x_v1"));
    await channel.init();

    expect(await channel.handshake("client-fp")).toEqual({ buildFingerprint: "daemon-fp" });
    await channel.requestShutdown();
    await channel.close();

    expect(seen.map((r) => r.op)).toEqual(["handshake", "shutdown"]);
    expect(seen[0]?.params).toMatchObject({ buildFingerprint: "client-fp" });
  });

  it("refuses a write op after restrictToReads without touching the socket, reads still pass", async () => {
    const seen: DaemonRequest[] = [];
    const socketPath = await daemonStandIn((r) => {
      seen.push(r);
      return 0;
    });
    const channel = new DaemonOpChannel(socketPath, fixturePhysicalCollectionName("code_x_v1"));
    await channel.init();
    channel.restrictToReads({ clientFingerprint: "old", daemonFingerprint: "new" });

    await expect(channel.call("checkpoint", {})).rejects.toBeInstanceOf(CodegraphClientStaleBuildError);
    expect(await channel.call("getFanOut", { relPath: "a.ts" })).toBe(0);
    await channel.close();

    expect(seen.map((r) => r.op)).toEqual(["getFanOut"]);
  });

  it("exposes the physical collection it serves", () => {
    const channel = new DaemonOpChannel("/nonexistent.sock", fixturePhysicalCollectionName("code_x_v1"));
    expect(channel.physicalCollectionName).toBe("code_x_v1");
  });
});
