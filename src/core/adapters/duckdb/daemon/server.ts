import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import { physicalCollectionNameFromDaemonRequest } from "../../../infra/collection-name.js";
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
    const { graphDb } =
      command.access === "write" ? await this.acquireForWrite(collection) : await this.pool.acquire(collection);
    return command.run(graphDb, p);
  }
}
