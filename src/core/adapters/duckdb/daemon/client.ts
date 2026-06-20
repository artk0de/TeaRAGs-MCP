import { connect, type Socket } from "node:net";

import type {
  CalleeEdge,
  CallerEdge,
  CycleEntry,
  CycleScope,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  HierarchySnapshot,
  InheritanceEdge,
  RelPath,
  ResolveRunStatsRow,
  SymbolChunkLocation,
  SymbolDefinition,
  SymbolId,
} from "../../../contracts/types/codegraph.js";
import { decodeFrames, encodeFrame, type DaemonOp, type DaemonResponse } from "./protocol.js";

/**
 * Thrown when a daemon-internal op is invoked on the daemon client. In daemon
 * mode the `DaemonGraphDbClient` is the SOLE accessor of the DuckDB file, so it
 * proxies the ENTIRE `GraphDbClient` surface — every write AND every read — over
 * the socket. The lone exception is `streamAdjacency`: the heavy graph analysis
 * runs daemon-side via `computeAndPersistCyclesAndSignals`, so the adjacency
 * stream must NOT cross IPC and still throws this error if called on the client.
 */
export class UnsupportedDaemonReadError extends Error {
  constructor(op: string) {
    super(`DaemonGraphDbClient is write-only; read op "${op}" must use the in-process RO handle`);
    this.name = "UnsupportedDaemonReadError";
  }
}

/**
 * `GraphDbClient` that proxies the entire codegraph surface — every mutation
 * and every read — to the codegraph daemon over a unix socket using
 * newline-JSON framing. Each call gets a monotonic id; responses are matched
 * back by id through the `pending` map. Only `streamAdjacency` is NOT proxied:
 * it stays daemon-internal (consumed by the daemon-side
 * `computeAndPersistCyclesAndSignals`) and throws `UnsupportedDaemonReadError`.
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

  // ── writes (proxied over the socket) ──

  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    await this.call("upsertFile", { node, edges });
  }

  async removeFile(relPath: RelPath): Promise<void> {
    await this.call("removeFile", { relPath });
  }

  async removeSymbolsForFile(relPath: RelPath): Promise<void> {
    await this.call("removeSymbolsForFile", { relPath });
  }

  async upsertSymbols(relPath: RelPath, definitions: SymbolDefinition[]): Promise<void> {
    await this.call("upsertSymbols", { relPath, definitions });
  }

  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    await this.call("updateSymbolChunkIds", { relPath, chunkIds: [...chunkIds.entries()] });
  }

  async findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    return (await this.call("findSymbolChunk", { symbolId })) as SymbolChunkLocation | null;
  }

  async replaceCycles(scope: CycleScope, sccs: readonly (readonly string[])[]): Promise<void> {
    await this.call("replaceCycles", { scope, sccs });
  }

  async replacePageRanks(ranks: ReadonlyMap<string, number>): Promise<void> {
    // A Map cannot JSON-serialise — send entries; the server rebuilds the Map.
    await this.call("replacePageRanks", { ranks: [...ranks.entries()] });
  }

  async checkpoint(): Promise<void> {
    await this.call("checkpoint", {});
  }

  async recordRunStats(rows: ResolveRunStatsRow[]): Promise<void> {
    await this.call("recordRunStats", { rows });
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

  // ── reads (proxied over the socket) ──
  // Every read routes through the daemon's own RW connection: DuckDB's RW lock
  // is process-exclusive, so a cross-process READ_ONLY attach throws
  // "Conflicting lock is held" while the daemon holds RW. The daemon being the
  // sole file opener means zero conflict. `streamAdjacency` is the ONE read
  // that stays daemon-internal (below) — its heavy adjacency stream must not
  // cross IPC and is consumed daemon-side by computeAndPersistCyclesAndSignals.

  async getFanIn(relPath: RelPath): Promise<number> {
    return (await this.call("getFanIn", { relPath })) as number;
  }

  async getFanInP95(): Promise<number> {
    return (await this.call("getFanInP95", {})) as number;
  }

  async getFanOut(relPath: RelPath): Promise<number> {
    return (await this.call("getFanOut", { relPath })) as number;
  }

  async getCallers(symbolId: SymbolId): Promise<CallerEdge[]> {
    return (await this.call("getCallers", { symbolId })) as CallerEdge[];
  }

  async getCallees(symbolId: SymbolId): Promise<CalleeEdge[]> {
    return (await this.call("getCallees", { symbolId })) as CalleeEdge[];
  }

  async getCalleeEdges(symbolIds: SymbolId[]): Promise<Map<SymbolId, SymbolId[]>> {
    // The server serialises the `Map<SymbolId, SymbolId[]>` as `[key, value][]`
    // entries (a Map cannot JSON-serialise) — rebuild the Map here.
    const entries = (await this.call("getCalleeEdges", { symbolIds })) as [SymbolId, SymbolId[]][];
    return new Map(entries);
  }

  async getCalledByCount(symbolId: SymbolId): Promise<number> {
    return (await this.call("getCalledByCount", { symbolId })) as number;
  }

  async getCallSiteCount(symbolId: SymbolId): Promise<number> {
    return (await this.call("getCallSiteCount", { symbolId })) as number;
  }

  async hasData(): Promise<boolean> {
    return (await this.call("hasData", {})) as boolean;
  }

  async getRunStats(): Promise<ResolveRunStatsRow[]> {
    return (await this.call("getRunStats", {})) as ResolveRunStatsRow[];
  }

  async listAllSymbols(): Promise<SymbolDefinition[]> {
    return (await this.call("listAllSymbols", {})) as SymbolDefinition[];
  }

  async getTransitiveImpact(relPath: RelPath, maxDepth?: number): Promise<number> {
    return (await this.call("getTransitiveImpact", { relPath, maxDepth })) as number;
  }

  async findCycles(scope: CycleScope, pathPattern?: string): Promise<CycleEntry[]> {
    return (await this.call("findCycles", { scope, pathPattern })) as CycleEntry[];
  }

  async listAdjacency(scope: CycleScope): Promise<Map<string, string[]>> {
    // The server serialises the `Map<string, string[]>` as `[key, value][]`
    // entries (a Map cannot JSON-serialise) — rebuild the Map here.
    const entries = (await this.call("listAdjacency", { scope })) as [string, string[]][];
    return new Map(entries);
  }

  async getPageRank(symbolId: SymbolId): Promise<number> {
    return (await this.call("getPageRank", { symbolId })) as number;
  }

  async getSupertypes(fqName: string): Promise<InheritanceEdge[]> {
    return (await this.call("getSupertypes", { fqName })) as InheritanceEdge[];
  }

  async getSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    return (await this.call("getSubtypes", { fqName })) as InheritanceEdge[];
  }

  async getTransitiveSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    return (await this.call("getTransitiveSubtypes", { fqName })) as InheritanceEdge[];
  }

  async loadHierarchySnapshot(): Promise<HierarchySnapshot> {
    // HierarchySnapshot is plain Records of arrays — JSON-serialisable as-is,
    // no Map rebuild needed (unlike getCalleeEdges / listAdjacency).
    return (await this.call("loadHierarchySnapshot", {})) as HierarchySnapshot;
  }

  // ── daemon-internal (NOT proxied) ──
  // `streamAdjacency` stays daemon-internal: the heavy graph analysis runs
  // inside the daemon (computeAndPersistCyclesAndSignals), so streaming the
  // adjacency over IPC is never correct. Throws on first iteration.

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
}
