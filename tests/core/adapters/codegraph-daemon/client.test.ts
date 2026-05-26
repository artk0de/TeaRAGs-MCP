import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonGraphDbClient } from "../../../../src/core/adapters/codegraph-daemon/client.js";
import {
  encodeFrame,
  decodeFrames,
  type DaemonRequest,
} from "../../../../src/core/adapters/codegraph-daemon/protocol.js";

let dir: string;
let srv: Server | undefined;
afterEach(async () => {
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
});

async function echoServer(
  socketPath: string,
  onReq: (r: DaemonRequest) => unknown,
): Promise<void> {
  srv = createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        const req = JSON.parse(f) as DaemonRequest;
        sock.write(encodeFrame({ id: req.id, ok: true, result: onReq(req) }));
      }
    });
  });
  srv.unref();
  const server = srv;
  return new Promise((res) => {
    server.listen(socketPath, () => {
      res();
    });
  });
}

describe("DaemonGraphDbClient", () => {
  it("upsertFile sends an upsertFile request and resolves on ok", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-"));
    const socketPath = join(dir, "d.sock");
    const seen: DaemonRequest[] = [];
    await echoServer(socketPath, (r) => {
      seen.push(r);
      return null;
    });

    const client = new DaemonGraphDbClient(socketPath, "code_x_v1");
    await client.init();
    await client.upsertFile(
      { relPath: "a.ts", language: "typescript" },
      { fileEdges: [], methodEdges: [] },
    );
    await client.close();

    expect(seen.map((r) => r.op)).toContain("upsertFile");
    // The request must carry the collection injected by the client.
    const upsert = seen.find((r) => r.op === "upsertFile");
    expect((upsert?.params as { collection: string }).collection).toBe("code_x_v1");
  });

  it("read methods throw (reads go through in-process RO handle)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-"));
    const socketPath = join(dir, "d.sock");
    await echoServer(socketPath, () => null);
    const client = new DaemonGraphDbClient(socketPath, "code_x_v1");
    await client.init();
    await expect(client.getCallers("Foo#bar")).rejects.toThrow();
    await client.close();
  });
});
