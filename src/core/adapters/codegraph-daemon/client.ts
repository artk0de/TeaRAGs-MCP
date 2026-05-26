import { connect, type Socket } from "node:net";
import type {
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  RelPath,
  SymbolId,
  SymbolDefinition,
  CallerEdge,
  CalleeEdge,
  CycleEntry,
  CycleScope,
} from "../../contracts/types/codegraph.js";
import { encodeFrame, decodeFrames, type DaemonOp, type DaemonResponse } from "./protocol.js";

/**
 * Thrown when a read op is invoked on the write-only daemon client. Reads must
 * go through the in-process READ_ONLY DuckDB handle (`pool.acquireRead`), never
 * the daemon socket — the daemon owns the single RW connection and does not
 * answer queries.
 */
export class UnsupportedDaemonReadError extends Error {
  constructor(op: string) {
    super(
      `DaemonGraphDbClient is write-only; read op "${op}" must use the in-process RO handle`,
    );
    this.name = "UnsupportedDaemonReadError";
  }
}

/**
 * Write-subset `GraphDbClient` that proxies mutations to the codegraph daemon
 * over a unix socket using newline-JSON framing. Each call gets a monotonic id;
 * responses are matched back by id through the `pending` map. Read methods throw
 * `UnsupportedDaemonReadError` — the read path opens the live-version DuckDB file
 * READ_ONLY in-process instead.
 */
export class DaemonGraphDbClient implements GraphDbClient {
  private sock?: Socket;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(
    private readonly socketPath: string,
    private readonly collection: string,
  ) {}

  async init(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = connect(this.socketPath);
      this.sock = sock;
      sock.once("connect", () => {
        resolve();
      });
      sock.once("error", (err) => {
        reject(err);
      });
      sock.on("data", (d) => {
        this.onData(d.toString("utf8"));
      });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    const { frames, rest } = decodeFrames(this.buf);
    this.buf = rest;
    for (const f of frames) {
      const res = JSON.parse(f) as DaemonResponse;
      const p = this.pending.get(res.id);
      if (!p) continue;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(Object.assign(new Error(res.error.message), { name: res.error.name }));
    }
  }

  private async call(op: DaemonOp, params: Record<string, unknown>): Promise<unknown> {
    const { sock } = this;
    if (!sock) throw new Error("DaemonGraphDbClient.call before init() / after close()");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      sock.write(
        encodeFrame({
          id,
          op,
          params: { collection: this.collection, ...params },
        } as never),
      );
    });
  }

  async close(): Promise<void> {
    this.sock?.end();
    this.sock = undefined;
    for (const [, p] of this.pending) {
      p.reject(new Error("DaemonGraphDbClient closed before response arrived"));
    }
    this.pending.clear();
  }

  // ── write subset (proxied over the socket) ──

  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    await this.call("upsertFile", { node, edges });
  }

  async removeSymbolsForFile(relPath: RelPath): Promise<void> {
    await this.call("removeSymbolsForFile", { relPath });
  }

  async checkpoint(): Promise<void> {
    await this.call("checkpoint", {});
  }

  /**
   * Concrete daemon method (NOT yet on the `GraphDbClient` interface — added in
   * Task 7). Runs SCC + PageRank daemon-side so the heavy graph build stays in
   * the single daemon process.
   */
  async computeAndPersistCyclesAndSignals(): Promise<void> {
    await this.call("computeAndPersistCyclesAndSignals", {});
  }

  // ── read subset (unsupported on the daemon client — use in-process RO handle) ──

  async removeFile(_relPath: RelPath): Promise<void> {
    throw new UnsupportedDaemonReadError("removeFile");
  }

  async getFanIn(_relPath: RelPath): Promise<number> {
    throw new UnsupportedDaemonReadError("getFanIn");
  }

  async getFanOut(_relPath: RelPath): Promise<number> {
    throw new UnsupportedDaemonReadError("getFanOut");
  }

  async getCallers(_symbolId: SymbolId): Promise<CallerEdge[]> {
    throw new UnsupportedDaemonReadError("getCallers");
  }

  async getCallees(_symbolId: SymbolId): Promise<CalleeEdge[]> {
    throw new UnsupportedDaemonReadError("getCallees");
  }

  async getCalledByCount(_symbolId: SymbolId): Promise<number> {
    throw new UnsupportedDaemonReadError("getCalledByCount");
  }

  async getCallSiteCount(_symbolId: SymbolId): Promise<number> {
    throw new UnsupportedDaemonReadError("getCallSiteCount");
  }

  async hasData(): Promise<boolean> {
    throw new UnsupportedDaemonReadError("hasData");
  }

  async upsertSymbols(_relPath: RelPath, _definitions: SymbolDefinition[]): Promise<void> {
    throw new UnsupportedDaemonReadError("upsertSymbols");
  }

  async listAllSymbols(): Promise<SymbolDefinition[]> {
    throw new UnsupportedDaemonReadError("listAllSymbols");
  }

  async getTransitiveImpact(_relPath: RelPath, _maxDepth?: number): Promise<number> {
    throw new UnsupportedDaemonReadError("getTransitiveImpact");
  }

  async findCycles(_scope: CycleScope): Promise<CycleEntry[]> {
    throw new UnsupportedDaemonReadError("findCycles");
  }

  async listAdjacency(_scope: CycleScope): Promise<Map<string, string[]>> {
    throw new UnsupportedDaemonReadError("listAdjacency");
  }

  streamAdjacency(_scope: CycleScope): AsyncIterableIterator<[string, string]> {
    const error = new UnsupportedDaemonReadError("streamAdjacency");
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<[string, string]>> {
        throw error;
      },
    };
  }

  async replaceCycles(_scope: CycleScope, _sccs: readonly (readonly string[])[]): Promise<void> {
    throw new UnsupportedDaemonReadError("replaceCycles");
  }

  async replacePageRanks(_ranks: ReadonlyMap<string, number>): Promise<void> {
    throw new UnsupportedDaemonReadError("replacePageRanks");
  }

  async getPageRank(_symbolId: SymbolId): Promise<number> {
    throw new UnsupportedDaemonReadError("getPageRank");
  }
}
