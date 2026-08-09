import type { CollectionGraphHandle, GraphDbClientPool } from "../pool.js";
import { getBuildFingerprint } from "./build-fingerprint.js";
import type { DaemonMemoryGovernor } from "./memory-governor.js";
import { DAEMON_OP_COMMANDS, type DaemonOpCommand } from "./op-commands.js";
import type { DaemonRequest, DaemonResponse } from "./protocol.js";

/**
 * In-process request handler for the codegraph daemon. Owns the internal
 * read-write `GraphDbClientPool`; every `DaemonRequest` is dispatched
 * against the pooled `graphDb` for its collection. Heavy graph analysis
 * (`computeAndPersistCyclesAndSignals`) runs here — confined to the single
 * daemon process so the ~30 GB collectAdjacency/Tarjan/PageRank allocation
 * never multiplies across MCP client processes, and so cross-process
 * single-writer DuckDB lock contention is eliminated at the source.
 *
 * The transport layer (socket framing in `entry.ts`, Task 9) wraps this:
 * `handle` is pure request → response and never throws — failures surface
 * as `{ ok: false, error }` so the socket loop can keep serving.
 *
 * WHAT each op does lives in `op-commands.ts` (`DAEMON_OP_COMMANDS`); this
 * class owns only HOW an op reaches its handle — pool acquisition, governor
 * notification, and the never-throw response envelope.
 */
export class CodegraphDaemonServer {
  constructor(
    private readonly pool: GraphDbClientPool,
    /**
     * This daemon's build identity, returned in every handshake response so a
     * client from a different build can decide to drain-restart the daemon
     * (bd tea-rags-mcp-ji56r). Injectable for tests; defaults to the shared
     * module-computed fingerprint (env-overridable).
     */
    private readonly buildFingerprint: string = getBuildFingerprint(),
    /**
     * Optional adaptive memory governor (bd tea-rags-mcp-1ruih). When wired,
     * every write op notifies it so the FIRST write of an ingest burst raises
     * the DuckDB memory_limit to the configured ceiling. Reads never notify —
     * the governor is write-burst-scoped by design.
     */
    private readonly governor?: DaemonMemoryGovernor,
  ) {}

  /**
   * Acquire the pooled handle for a WRITE op and notify the memory governor
   * (`onWrite` is a no-op for already-raised collections — one live SET per
   * burst). `finalizeReindex` does NOT route through here: it only unlinks the
   * superseded DB file, so there is no open handle to govern.
   */
  private async acquireForWrite(collection: string): Promise<CollectionGraphHandle> {
    const handle = await this.pool.acquire(collection);
    await this.governor?.onWrite(collection, handle.graphDb);
    return handle;
  }

  async handle(req: DaemonRequest): Promise<DaemonResponse> {
    try {
      const result = await this.dispatch(req);
      return { id: req.id, ok: true, result };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return { id: req.id, ok: false, error: { name: e.name, message: e.message } };
    }
  }

  private async dispatch(req: DaemonRequest): Promise<unknown> {
    // `req.op` is typed, but the wire is not: an op this build does not know
    // arrives as a plain string and must fall through to the same error the
    // switch's `default` produced.
    const command = DAEMON_OP_COMMANDS[req.op] as DaemonOpCommand | undefined;
    if (!command) throw new Error(`unknown daemon op: ${String(req.op)}`);

    const p = req.params as Record<string, unknown>;
    if (command.access === "daemon") {
      return command.run({ pool: this.pool, buildFingerprint: this.buildFingerprint }, p);
    }

    const collection = p.collection as string;
    const { graphDb } =
      command.access === "write" ? await this.acquireForWrite(collection) : await this.pool.acquire(collection);
    return command.run(graphDb, p);
  }
}
