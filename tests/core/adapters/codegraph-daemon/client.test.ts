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

  it("getCallers / getCallees / findCycles proxy through the daemon socket and resolve the result", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-"));
    const socketPath = join(dir, "d.sock");
    const seen: DaemonRequest[] = [];
    // Echo server returns a deterministic payload per read op so the client
    // proxy round-trip can be asserted end-to-end.
    await echoServer(socketPath, (r) => {
      seen.push(r);
      if (r.op === "getCallers") {
        return [{ sourceSymbolId: "A#run", sourceRelPath: "a.ts", callExpression: "b.help()" }];
      }
      if (r.op === "getCallees") {
        return [{ targetSymbolId: "B#help", targetRelPath: "b.ts", callExpression: "b.help()" }];
      }
      if (r.op === "findCycles") {
        return [{ cycleId: 0, scope: "file", members: ["a.ts", "b.ts"] }];
      }
      return null;
    });

    const client = new DaemonGraphDbClient(socketPath, "code_x_v1");
    await client.init();

    const callers = await client.getCallers("B#help");
    const callees = await client.getCallees("A#run");
    const cycles = await client.findCycles("file");
    await client.close();

    expect(callers).toEqual([
      { sourceSymbolId: "A#run", sourceRelPath: "a.ts", callExpression: "b.help()" },
    ]);
    expect(callees).toEqual([
      { targetSymbolId: "B#help", targetRelPath: "b.ts", callExpression: "b.help()" },
    ]);
    expect(cycles).toEqual([{ cycleId: 0, scope: "file", members: ["a.ts", "b.ts"] }]);
    // Each read op carries the client-injected collection + its query param.
    expect(seen.map((r) => r.op)).toEqual(["getCallers", "getCallees", "findCycles"]);
    expect(seen.every((r) => (r.params as { collection: string }).collection === "code_x_v1")).toBe(
      true,
    );
    expect((seen[0].params as { symbolId: string }).symbolId).toBe("B#help");
    expect((seen[2].params as { scope: string }).scope).toBe("file");
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

  it("every still-unsupported read method rejects with UnsupportedDaemonReadError naming the op", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-"));
    const socketPath = join(dir, "d.sock");
    await echoServer(socketPath, () => null);
    const client = new DaemonGraphDbClient(socketPath, "code_x_v1");
    await client.init();

    // getCallers/getCallees/findCycles now PROXY (covered above). Everything
    // else is still unsupported on the daemon client and throws on call;
    // streamAdjacency throws on first iteration.
    await expect(client.getFanIn("a.ts")).rejects.toThrow(/getFanIn/);
    await expect(client.getFanOut("a.ts")).rejects.toThrow(/getFanOut/);
    await expect(client.getCalledByCount("Foo#bar")).rejects.toThrow(/getCalledByCount/);
    await expect(client.getCallSiteCount("Foo#bar")).rejects.toThrow(/getCallSiteCount/);
    await expect(client.hasData()).rejects.toThrow(/hasData/);
    await expect(client.removeFile("a.ts")).rejects.toThrow(/removeFile/);
    await expect(client.upsertSymbols("a.ts", [])).rejects.toThrow(/upsertSymbols/);
    await expect(client.listAllSymbols()).rejects.toThrow(/listAllSymbols/);
    await expect(client.getTransitiveImpact("a.ts")).rejects.toThrow(/getTransitiveImpact/);
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

  it("init() retries the connect until the daemon's socket appears (spawn race)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-"));
    const socketPath = join(dir, "late.sock");

    // The server starts listening ~150ms AFTER init() is called — simulating
    // the detached-spawn → connect race the daemon default exposes. init()
    // must keep retrying the connect rather than reject on the first ENOENT.
    const seen: DaemonRequest[] = [];
    const startServerLate = setTimeout(() => {
      void echoServer(socketPath, (r) => {
        seen.push(r);
        return null;
      });
    }, 150);

    const client = new DaemonGraphDbClient(socketPath, "code_late_v1", {
      connectTimeoutMs: 5000,
      retryDelayMs: 50,
    });
    await client.init();
    // A real round-trip after the late connect proves the socket is usable.
    await client.upsertFile(
      { relPath: "a.ts", language: "typescript" },
      { fileEdges: [], methodEdges: [] },
    );
    await client.close();

    clearTimeout(startServerLate);
    expect(seen.map((r) => r.op)).toContain("upsertFile");
  });

  it("init() rejects within the configured timeout when no daemon ever appears", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-"));
    const socketPath = join(dir, "never.sock");
    // No server is ever started. init() must give up after connectTimeoutMs
    // rather than retry forever.
    const client = new DaemonGraphDbClient(socketPath, "code_never_v1", {
      connectTimeoutMs: 300,
      retryDelayMs: 50,
    });
    const start = Date.now();
    await expect(client.init()).rejects.toThrow();
    const elapsed = Date.now() - start;
    // Bounded: gave up near the configured timeout, not after the default 5s.
    expect(elapsed).toBeLessThan(2000);
  });
});
