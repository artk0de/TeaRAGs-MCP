import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
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

  it("the full write subset proxies the matching op + injected collection over the socket", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-"));
    const socketPath = join(dir, "d.sock");
    const seen: DaemonRequest[] = [];
    await echoServer(socketPath, (r) => {
      seen.push(r);
      return null;
    });

    const client = new DaemonGraphDbClient(socketPath, "code_x_v9");
    await client.init();
    await client.removeSymbolsForFile("a.ts");
    await client.checkpoint();
    await client.computeAndPersistCyclesAndSignals();
    await client.finalizeReindex("code_x_v8", "code_x_v9");
    await client.close();

    expect(seen.map((r) => r.op)).toEqual([
      "removeSymbolsForFile",
      "checkpoint",
      "computeAndPersistCyclesAndSignals",
      "finalizeReindex",
    ]);
    // Every request carries the client-injected collection.
    expect(seen.every((r) => (r.params as { collection: string }).collection === "code_x_v9")).toBe(
      true,
    );
    // finalizeReindex threads both versions through params.
    const fin = seen.find((r) => r.op === "finalizeReindex");
    expect(fin?.params).toMatchObject({ oldVersion: "code_x_v8", newVersion: "code_x_v9" });
  });

  it("every read method rejects with UnsupportedDaemonReadError naming the op", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-"));
    const socketPath = join(dir, "d.sock");
    await echoServer(socketPath, () => null);
    const client = new DaemonGraphDbClient(socketPath, "code_x_v1");
    await client.init();

    // Each read op throws; streamAdjacency throws on first iteration.
    await expect(client.getCallees("Foo#bar")).rejects.toThrow(/getCallees/);
    await expect(client.getFanIn("a.ts")).rejects.toThrow(/getFanIn/);
    await expect(client.getFanOut("a.ts")).rejects.toThrow(/getFanOut/);
    await expect(client.getCalledByCount("Foo#bar")).rejects.toThrow(/getCalledByCount/);
    await expect(client.getCallSiteCount("Foo#bar")).rejects.toThrow(/getCallSiteCount/);
    await expect(client.hasData()).rejects.toThrow(/hasData/);
    await expect(client.removeFile("a.ts")).rejects.toThrow(/removeFile/);
    await expect(client.upsertSymbols("a.ts", [])).rejects.toThrow(/upsertSymbols/);
    await expect(client.listAllSymbols()).rejects.toThrow(/listAllSymbols/);
    await expect(client.getTransitiveImpact("a.ts")).rejects.toThrow(/getTransitiveImpact/);
    await expect(client.findCycles("file")).rejects.toThrow(/findCycles/);
    await expect(client.listAdjacency("file")).rejects.toThrow(/listAdjacency/);
    await expect(client.replaceCycles("file", [])).rejects.toThrow(/replaceCycles/);
    await expect(client.replacePageRanks(new Map())).rejects.toThrow(/replacePageRanks/);
    await expect(client.getPageRank("Foo#bar")).rejects.toThrow(/getPageRank/);
    await expect(async () => {
      for await (const _ of client.streamAdjacency("method")) {
        /* unreachable — first next() throws */
      }
    }).rejects.toThrow(/streamAdjacency/);

    await client.close();
  });

  it("close() rejects any in-flight call awaiting a response", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-"));
    const socketPath = join(dir, "d.sock");
    // Server that NEVER responds — the call stays pending until close.
    // Track connections so the test can destroy them itself (a hung
    // never-responding socket would otherwise stall the afterEach close).
    const conns = new Set<Socket>();
    const noReplyServer = createServer((sock) => {
      conns.add(sock);
      sock.on("close", () => conns.delete(sock));
    });
    noReplyServer.unref();
    await new Promise<void>((res) => {
      noReplyServer.listen(socketPath, () => {
        res();
      });
    });

    const client = new DaemonGraphDbClient(socketPath, "code_x_v1");
    await client.init();
    const pending = client.checkpoint();
    await client.close();
    await expect(pending).rejects.toThrow(/closed before response/);

    for (const c of conns) c.destroy();
    await new Promise<void>((res) => {
      noReplyServer.close(() => {
        res();
      });
    });
  });

  it("calling a write op after close() throws (no live socket)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-"));
    const socketPath = join(dir, "d.sock");
    await echoServer(socketPath, () => null);
    const client = new DaemonGraphDbClient(socketPath, "code_x_v1");
    await client.init();
    await client.close();
    await expect(client.checkpoint()).rejects.toThrow(/before init|after close/);
  });
});
