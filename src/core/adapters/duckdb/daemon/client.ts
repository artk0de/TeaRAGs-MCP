import { connect, type Socket } from "node:net";

import type {
  CalleeEdge,
  CallerEdge,
  CycleEntry,
  CycleScope,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  RelPath,
  SymbolDefinition,
  SymbolId,
} from "../../../contracts/types/codegraph.js";
import { decodeFrames, encodeFrame, type DaemonOp, type DaemonResponse } from "./protocol.js";

/**
 * Thrown when an unsupported read op is invoked on the daemon client. The three
 * GraphFacade reads (`getCallers` / `getCallees` / `findCycles`) are now PROXIED
 * over the socket — the daemon owns the single RW connection and DuckDB's RW
 * lock is process-exclusive, so a cross-process READ_ONLY attach throws
 * "Conflicting lock is held". All OTHER reads are daemon-internal / unused by
 * the facade and still throw this error if called on the client.
 */
export class UnsupportedDaemonReadError extends Error {
  constructor(op: string) {
    super(`DaemonGraphDbClient is write-only; read op "${op}" must use the in-process RO handle`);
    this.name = "UnsupportedDaemonReadError";
  }
}

/**
 * `GraphDbClient` that proxies mutations AND the three GraphFacade reads
 * (`getCallers` / `getCallees` / `findCycles`) to the codegraph daemon over a
 * unix socket using newline-JSON framing. Each call gets a monotonic id;
 * responses are matched back by id through the `pending` map. All other read
 * methods throw `UnsupportedDaemonReadError` — they are daemon-internal and not
 * part of the facade surface.
 */
/** Tunable connect-readiness window for the spawn→connect race. */
export interface DaemonClientOptions {
  /**
   * Upper bound on how long `init()` keeps retrying the unix-socket connect
   * before rejecting. Default ~5s — generous enough for a detached daemon to
   * finish `server.listen` after a cold spawn, bounded so a permanently-absent
   * daemon surfaces loudly instead of hanging.
   */
  connectTimeoutMs?: number;
  /** Delay between connect attempts when the socket is not yet accepting. */
  retryDelayMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 75;

/** ENOENT (socket file not created yet) / ECONNREFUSED (server not listening yet). */
function isRetryableConnectError(err: NodeJS.ErrnoException): boolean {
  return err.code === "ENOENT" || err.code === "ECONNREFUSED";
}

export class DaemonGraphDbClient implements GraphDbClient {
  private sock?: Socket;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly connectTimeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly socketPath: string,
    private readonly collection: string,
    opts?: DaemonClientOptions,
  ) {
    this.connectTimeoutMs = opts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  /**
   * Connect to the daemon socket, retrying on ENOENT/ECONNREFUSED with a small
   * backoff until the socket accepts or `connectTimeoutMs` elapses. This absorbs
   * the detached-spawn race: the factory spawns the daemon process, then the
   * very next `acquireWrite` calls `init()` before the daemon has reached
   * `server.listen`. Without the retry that connect throws ENOENT and the whole
   * write fails. A non-retryable error (or timeout) rejects with a clear cause.
   */
  async init(): Promise<void> {
    const deadline = Date.now() + this.connectTimeoutMs;
    for (;;) {
      try {
        await this.connectOnce();
        return;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        const timedOut = Date.now() + this.retryDelayMs >= deadline;
        if (!isRetryableConnectError(e) || timedOut) {
          throw new Error(
            `DaemonGraphDbClient failed to connect to ${this.socketPath} within ` +
              `${this.connectTimeoutMs}ms: ${e.code ?? e.message}`,
            { cause: err },
          );
        }
        await new Promise<void>((r) => setTimeout(r, this.retryDelayMs));
      }
    }
  }

  /** Single connect attempt; resolves on `connect`, rejects on `error`. */
  private async connectOnce(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = connect(this.socketPath);
      const onError = (err: Error): void => {
        sock.destroy();
        reject(err);
      };
      sock.once("connect", () => {
        sock.removeListener("error", onError);
        this.sock = sock;
        sock.on("error", () => {
          /* post-connect peer errors are surfaced via pending-call rejection */
        });
        sock.on("data", (d) => {
          this.onData(d.toString("utf8"));
        });
        resolve();
      });
      sock.once("error", onError);
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
   * Delete the superseded version's DuckDB file after the Qdrant alias swap.
   * Concrete daemon method (NOT on the `GraphDbClient` interface) — driven by
   * the force-reindex path once the alias flips readers onto `newVersion`.
   */
  async finalizeReindex(oldVersion: string, newVersion: string): Promise<void> {
    await this.call("finalizeReindex", { oldVersion, newVersion });
  }

  /**
   * Concrete daemon method (NOT yet on the `GraphDbClient` interface — added in
   * Task 7). Runs SCC + PageRank daemon-side so the heavy graph build stays in
   * the single daemon process.
   */
  async computeAndPersistCyclesAndSignals(): Promise<void> {
    await this.call("computeAndPersistCyclesAndSignals", {});
  }

  // ── proxied reads (the GraphFacade read surface) ──
  // These three reads route through the daemon's own RW connection: DuckDB's
  // RW lock is process-exclusive, so a cross-process READ_ONLY attach throws
  // "Conflicting lock is held" while the daemon holds RW. The daemon being the
  // sole file opener means zero conflict. The remaining read methods below stay
  // daemon-internal / unsupported — they are not part of the GraphFacade surface.

  async getCallers(symbolId: SymbolId): Promise<CallerEdge[]> {
    return (await this.call("getCallers", { symbolId })) as CallerEdge[];
  }

  async getCallees(symbolId: SymbolId): Promise<CalleeEdge[]> {
    return (await this.call("getCallees", { symbolId })) as CalleeEdge[];
  }

  async findCycles(scope: CycleScope): Promise<CycleEntry[]> {
    return (await this.call("findCycles", { scope })) as CycleEntry[];
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
