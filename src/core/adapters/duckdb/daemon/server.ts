import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import { physicalCollectionNameFromDaemonRequest } from "../../../infra/collection-name.js";
import { CodegraphDaemonRequestAbortedError } from "../errors.js";
import type { CollectionGraphHandle, GraphDbClientPool } from "../pool.js";
import { getBuildFingerprint } from "./build-fingerprint.js";
import type { DaemonMemoryGovernor } from "./memory-governor.js";
import { DAEMON_OP_COMMANDS, type DaemonOpCommand, type DaemonOpCommandTable } from "./op-commands.js";
import type { DaemonOp, DaemonRequest, DaemonResponse } from "./protocol.js";

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
  /** Keys of the table this server dispatches on — what its handshake advertises. */
  private readonly supportedOps: readonly DaemonOp[];

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
    /**
     * The op table this server dispatches on, and therefore the capability
     * list its handshake advertises (bd tea-rags-mcp-39xca.4) — one source, so
     * the two cannot disagree. Defaults to the full `DAEMON_OP_COMMANDS`; tests
     * inject a trimmed table to stand in for a daemon from an older build.
     */
    private readonly commands: DaemonOpCommandTable = DAEMON_OP_COMMANDS,
  ) {
    this.supportedOps = Object.keys(commands) as DaemonOp[];
  }

  /**
   * Acquire the pooled handle for a WRITE op and notify the memory governor
   * (`onWrite` is a no-op for already-raised collections — one live SET per
   * burst). `finalizeReindex` does NOT route through here: it only unlinks the
   * superseded DB file, so there is no open handle to govern.
   */
  private async acquireForWrite(collection: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    const handle = await this.pool.acquire(collection);
    await this.governor?.onWrite(collection, handle.graphDb);
    return handle;
  }

  /**
   * `signal` is the requesting connection's, aborted when its socket closes
   * (bd tea-rags-mcp-f924y). The transport always passes one; a caller that
   * does not is treated as a connection that never closes.
   */
  async handle(req: DaemonRequest, signal?: AbortSignal): Promise<DaemonResponse> {
    try {
      const result = await this.dispatch(req, signal);
      return { id: req.id, ok: true, result };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return { id: req.id, ok: false, error: { name: e.name, message: e.message } };
    }
  }

  /**
   * Tail of each collection's write queue. Writes to one collection already run
   * one at a time — they share the collection's single DuckDB connection and its
   * transaction queue — so admitting them here, in arrival order, costs nothing
   * and gives the daemon the one point where a write has not started yet.
   */
  private readonly writeTails = new Map<PhysicalCollectionName, Promise<void>>();

  /**
   * Run a write once every earlier write to the collection has settled — and
   * drop it instead, with `CodegraphDaemonRequestAbortedError`, when its
   * connection closed while it waited (bd tea-rags-mcp-f924y). A killed CLI
   * worker used to leave its queued writes running for nobody, ahead of the
   * next session's.
   */
  private async admitWrite<T>(
    collection: PhysicalCollectionName,
    op: string,
    signal: AbortSignal | undefined,
    write: () => Promise<T>,
  ): Promise<T> {
    const previous = this.writeTails.get(collection) ?? Promise.resolve();
    let finished!: () => void;
    const settled = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const tail = previous.then(async () => settled);
    this.writeTails.set(collection, tail);
    try {
      await previous;
      if (signal?.aborted) throw new CodegraphDaemonRequestAbortedError(op);
      return await write();
    } finally {
      finished();
      if (this.writeTails.get(collection) === tail) this.writeTails.delete(collection);
    }
  }

  private async dispatch(req: DaemonRequest, signal: AbortSignal | undefined): Promise<unknown> {
    // `req.op` is typed, but the wire is not: an op this build does not know
    // arrives as a plain string and must fall through to the same error the
    // switch's `default` produced. `hasOwn`, so a prototype key such as
    // `toString` is unknown too rather than a function mistaken for a command.
    const command: DaemonOpCommand | undefined = Object.hasOwn(this.commands, req.op)
      ? this.commands[req.op]
      : undefined;
    if (!command) throw new Error(`unknown daemon op: ${String(req.op)}`);

    const p = req.params as Record<string, unknown>;
    if (command.access === "daemon") {
      return command.run(
        { pool: this.pool, buildFingerprint: this.buildFingerprint, supportedOps: this.supportedOps },
        p,
      );
    }

    // The client held a PhysicalCollectionName; the wire erased the brand.
    const collection = physicalCollectionNameFromDaemonRequest(p.collection);
    if (command.access === "write") {
      return this.admitWrite(collection, req.op, signal, async () => {
        const { graphDb } = await this.acquireForWrite(collection);
        return command.run(graphDb, p, signal);
      });
    }
    const { graphDb } = await this.pool.acquire(collection);
    return command.run(graphDb, p, signal);
  }
}
