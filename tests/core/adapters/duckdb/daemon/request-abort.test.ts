/**
 * The codegraph daemon stops working for a client whose connection closed
 * (bd tea-rags-mcp-f924y).
 *
 * The daemon is one process shared by every tea-rags process on the machine, and
 * writes to a collection run one at a time on its single DuckDB connection. A
 * killed CLI worker used to leave its queued writes — and a minutes-long graph
 * analysis — running daemon-side for nobody, holding the write queue and the
 * memory the next session was waiting on. Nobody reads the response of a closed
 * connection, so what has not started yet is dropped and the graph analysis
 * stops at its next phase boundary.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConnectionHandler } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { computeAndPersistCyclesAndSignals } from "../../../../../src/core/adapters/duckdb/daemon/graph-analysis.js";
import { getDaemonPaths } from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import type { DaemonOpCommandTable } from "../../../../../src/core/adapters/duckdb/daemon/op-commands.js";
import { encodeFrame, type DaemonRequest } from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { CodegraphDaemonServer } from "../../../../../src/core/adapters/duckdb/daemon/server.js";
import { CodegraphDaemonRequestAbortedError } from "../../../../../src/core/adapters/duckdb/errors.js";
import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import type { CycleScope, GraphDbClient } from "../../../../../src/core/contracts/types/codegraph.js";

/** A pool that hands out one inert handle — the ops under test never touch it. */
const inertPool = {
  // The server routes every per-collection op through `runCollectionOp` (bd
  // tea-rags-mcp-nlls) — the mock mirrors that seam, not the raw acquire.
  runCollectionOp: async <T>(
    _collection: unknown,
    op: (handle: { graphDb: GraphDbClient; symbolTable: unknown }) => Promise<T>,
  ) => op({ graphDb: {} as GraphDbClient, symbolTable: {} }),
} as unknown as GraphDbClientPool;

function request(id: number, op: string, params: Record<string, unknown>): DaemonRequest {
  return { id, op, params: { collection: "code_abort_v1", ...params } } as unknown as DaemonRequest;
}

describe("CodegraphDaemonServer — writes of a closed connection (f924y)", () => {
  let releaseFirst!: () => void;
  let ran: string[];
  let server: CodegraphDaemonServer;

  beforeEach(() => {
    ran = [];
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const commands: DaemonOpCommandTable = {
      upsertFile: {
        access: "write",
        run: async (_graphDb, p) => {
          ran.push(String(p.tag));
          if (p.tag === "first") await firstMayFinish;
          return null;
        },
      },
    };
    server = new CodegraphDaemonServer(inertPool, "fp-test", undefined, commands);
  });

  it("drops a write queued behind another client's write once its own connection closed", async () => {
    const first = server.handle(request(1, "upsertFile", { tag: "first" }), new AbortController().signal);
    const gone = new AbortController();
    const queued = server.handle(request(2, "upsertFile", { tag: "queued" }), gone.signal);

    gone.abort();
    releaseFirst();

    expect(await first).toMatchObject({ id: 1, ok: true });
    expect(await queued).toMatchObject({
      id: 2,
      ok: false,
      error: { name: "CodegraphDaemonRequestAbortedError" },
    });
    expect(ran).toEqual(["first"]);
  });

  it("still runs a queued write of a live connection, in arrival order", async () => {
    const live = new AbortController().signal;
    const first = server.handle(request(1, "upsertFile", { tag: "first" }), live);
    const second = server.handle(request(2, "upsertFile", { tag: "second" }), live);

    // The second write waits for the first — one write at a time per collection.
    await vi.waitFor(() => {
      expect(ran).toEqual(["first"]);
    });
    releaseFirst();

    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(ran).toEqual(["first", "second"]);
  });
});

describe("computeAndPersistCyclesAndSignals — stops for a closed connection (f924y)", () => {
  function graphWithAdjacency(onFirstEdge: () => void) {
    const replaced: CycleScope[] = [];
    let pageRanksReplaced = false;
    const graphDb = {
      async *streamAdjacency(): AsyncIterableIterator<[string, string, number?]> {
        onFirstEdge();
        yield ["a.ts", "b.ts"];
        yield ["b.ts", "a.ts"];
      },
      replaceCycles: async (scope: CycleScope) => {
        replaced.push(scope);
      },
      replacePageRanks: async () => {
        pageRanksReplaced = true;
      },
    } as unknown as GraphDbClient;
    return { graphDb, replaced, pageRanksReplaced: () => pageRanksReplaced };
  }

  it("persists nothing once the requesting connection closed mid-analysis", async () => {
    const gone = new AbortController();
    const graph = graphWithAdjacency(() => {
      gone.abort();
    });

    await expect(computeAndPersistCyclesAndSignals(graph.graphDb, gone.signal)).rejects.toBeInstanceOf(
      CodegraphDaemonRequestAbortedError,
    );
    expect(graph.replaced).toEqual([]);
    expect(graph.pageRanksReplaced()).toBe(false);
  });

  it("runs every phase for a live connection", async () => {
    const graph = graphWithAdjacency(() => undefined);

    await computeAndPersistCyclesAndSignals(graph.graphDb, new AbortController().signal);

    expect(graph.replaced).toEqual(["file", "method"]);
    expect(graph.pageRanksReplaced()).toBe(true);
  });
});

describe("createConnectionHandler — a socket's close aborts its requests (f924y)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cg-abort-conn-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands every request the connection's signal, aborted when the socket closes", async () => {
    const signals: AbortSignal[] = [];
    const server = {
      handle: vi.fn(async (req: DaemonRequest, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        return new Promise<never>(() => undefined);
      }),
    } as unknown as CodegraphDaemonServer;
    const sock = Object.assign(new EventEmitter(), { destroyed: false, write: vi.fn(), destroy: vi.fn() });

    createConnectionHandler(server, getDaemonPaths(dir))(sock as never);
    sock.emit("data", Buffer.from(encodeFrame(request(7, "upsertFile", {}) as never)));

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    sock.emit("close");
    expect(signals[0]?.aborted).toBe(true);
  });
});
