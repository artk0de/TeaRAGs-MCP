import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { DaemonGraphDbClient } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";

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

async function fakeDaemon(socketPath: string, onReq: (r: DaemonRequest) => unknown): Promise<void> {
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
  await new Promise<void>((res) =>
    server.listen(socketPath, () => {
      res();
    }),
  );
}

describe("DaemonGraphDbClient — residual ops", () => {
  it("sends each residual op with its params and returns the daemon's rows", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-residual-"));
    const socketPath = join(dir, "d.sock");
    const seen: DaemonRequest[] = [];
    await fakeDaemon(socketPath, (r) => {
      seen.push(r);
      if (r.op === "getModelResolvedSiteCounts") return [{ language: "ruby", sites: 1 }];
      return r.op === "readResidualCallSites" ? [{ siteKey: "k1" }] : null;
    });
    const edge = {
      siteKey: "k1",
      sourceRelPath: "a.rb",
      sourceSymbolId: "A#run",
      targetSymbolId: "B#go",
      model: "kev",
      p: 0.9,
    };

    const client = new DaemonGraphDbClient(socketPath, fixturePhysicalCollectionName("code_x_v1"));
    await client.init();
    const sites = await client.readResidualCallSites();
    await client.applyModelEdges("kev", [edge]);
    const resolvedSites = await client.getModelResolvedSiteCounts({ kev: 0.7 });
    await client.markDerivedStale();
    await client.close();

    expect(sites).toEqual([{ siteKey: "k1" }]);
    expect(seen.find((r) => r.op === "applyModelEdges")?.params).toMatchObject({
      collection: "code_x_v1",
      model: "kev",
      edges: [edge],
    });
    expect(resolvedSites).toEqual([{ language: "ruby", sites: 1 }]);
    expect(seen.find((r) => r.op === "getModelResolvedSiteCounts")?.params).toMatchObject({
      collection: "code_x_v1",
      thresholds: { kev: 0.7 },
    });
    expect(seen.map((r) => r.op)).toEqual(expect.arrayContaining(["readResidualCallSites", "markDerivedStale"]));
  });
});
