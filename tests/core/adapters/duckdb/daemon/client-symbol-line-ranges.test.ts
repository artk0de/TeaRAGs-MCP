/**
 * `getSymbolLineRangesBulk` over the daemon socket (bd tea-rags-mcp-9i2ow).
 *
 * The payload healer reads symbol ranges through whatever graph client the pool
 * hands it, and in production that is the daemon proxy. Two things must hold on
 * that path: the Map survives the JSON round trip, and a daemon from an OLDER
 * build — which the pool tolerates — degrades to "no ranges" (every chunk keeps
 * its own payload symbolId, the pre-ranges heal) instead of failing the heal.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { DaemonGraphDbClient } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import { DAEMON_OP_COMMANDS } from "../../../../../src/core/adapters/duckdb/daemon/op-commands.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";

let dir: string | undefined;
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
  dir = undefined;
});

/** `onReq` may return an `Error` to answer `ok: false`, standing in for an old or failing daemon. */
async function fakeDaemon(socketPath: string, onReq: (r: DaemonRequest) => unknown): Promise<void> {
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
  return new Promise((res) => {
    server.listen(socketPath, () => {
      res();
    });
  });
}

describe("DaemonGraphDbClient.getSymbolLineRangesBulk (bd tea-rags-mcp-9i2ow)", () => {
  it("sends the paths and rebuilds the per-file Map from the wire entries", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-ranges-"));
    const socketPath = join(dir, "d.sock");
    const seen: DaemonRequest[] = [];
    await fakeDaemon(socketPath, (r) => {
      seen.push(r);
      if (r.op !== "getSymbolLineRangesBulk") return null;
      return [["walker.ts", [{ symbolId: "outer.walkScope", startLine: 257, endLine: 300 }]]];
    });

    const client = new DaemonGraphDbClient(socketPath, "code_x_v1");
    await client.init();
    const ranges = await client.getSymbolLineRangesBulk(["walker.ts", "other.ts"]);
    await client.close();

    expect(ranges).toEqual(new Map([["walker.ts", [{ symbolId: "outer.walkScope", startLine: 257, endLine: 300 }]]]));
    expect(seen.find((r) => r.op === "getSymbolLineRangesBulk")?.params).toMatchObject({
      collection: "code_x_v1",
      relPaths: ["walker.ts", "other.ts"],
    });
  });

  it("answers no ranges when the daemon predates the op", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-ranges-"));
    const socketPath = join(dir, "d.sock");
    await fakeDaemon(socketPath, (r) =>
      r.op === "getSymbolLineRangesBulk" ? new Error("unknown daemon op: getSymbolLineRangesBulk") : null,
    );

    const client = new DaemonGraphDbClient(socketPath, "code_x_v1");
    await client.init();
    const ranges = await client.getSymbolLineRangesBulk(["walker.ts"]);
    await client.close();

    expect(ranges).toEqual(new Map());
  });

  it("propagates a genuine daemon failure instead of pretending there are no ranges", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-ranges-"));
    const socketPath = join(dir, "d.sock");
    await fakeDaemon(socketPath, (r) =>
      r.op === "getSymbolLineRangesBulk" ? new Error("IO Error: database is invalidated") : null,
    );

    const client = new DaemonGraphDbClient(socketPath, "code_x_v1");
    await client.init();
    await expect(client.getSymbolLineRangesBulk(["walker.ts"])).rejects.toThrow("database is invalidated");
    await client.close();
  });

  it("the daemon command reads the pooled graph and serialises the Map as entries", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-ranges-db-"));
    const graphDb = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await graphDb.init();
    await runMigrations(graphDb, DATABASE_MIGRATIONS);
    try {
      await graphDb.upsertSymbols("walker.ts", [
        {
          relPath: "walker.ts",
          symbolId: "outer",
          fqName: "outer",
          shortName: "outer",
          scope: [],
          startLine: 1,
          endLine: 9,
        },
      ]);
      const command = DAEMON_OP_COMMANDS.getSymbolLineRangesBulk;
      expect(command.access).toBe("read");
      const result = command.access === "read" ? await command.run(graphDb, { relPaths: ["walker.ts"] }) : undefined;
      expect(result).toEqual([["walker.ts", [{ symbolId: "outer", startLine: 1, endLine: 9 }]]]);
    } finally {
      await graphDb.close();
    }
  });
});
