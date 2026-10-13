/**
 * Daemon mode's per-collection client cache, split out of `GraphDbClientPool`
 * (0qaht.38): ONE `DaemonGraphDbClient` (one socket) per (collection, process),
 * shared by every acquire and closed only by `closeAll`, plus ONE hydrated
 * symbol table per collection. Which daemon a connect addresses, and whether
 * its build may serve this process, is `DaemonBuildHandshakeConnector`'s call.
 */

import { existsSync } from "node:fs";

import type { CollectionGraphHandle } from "../../../contracts/types/codegraph-pool.js";
import type { GlobalSymbolTable, GraphDbClient } from "../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { CollectionInitHook, SymbolTableFactory } from "../collection-init-hook.js";
import type {
  CodegraphDaemonClientTarget,
  CodegraphDaemonRestartWiring,
  DaemonCollectionClientCachePort,
} from "../daemon-ports.js";
import { CodegraphClientBuildTreeGoneError } from "../errors.js";
import type { DaemonBuildHandshakeConnector } from "./build-handshake-connector.js";
import type { DaemonGraphDbClient } from "./client.js";

/**
 * The daemon-client construction options — since H4a2 what a routing builder
 * (`createDaemonRouting`) receives; the fields carry the meaning they had on
 * `GraphDbClientPoolOptions`.
 */
export interface DaemonCollectionClientCacheOptions {
  symbolTableFactory: SymbolTableFactory;
  initHook?: CollectionInitHook;
  daemonSocketPath?: string;
  daemonClientTarget?: () => CodegraphDaemonClientTarget;
  daemonStorageDir?: string;
  /** Only `respawn` is read here; the rest of the wiring goes to the handshake connector. */
  daemonRestart?: CodegraphDaemonRestartWiring;
}

/**
 * Cached daemon-mode entry: the raw `DaemonGraphDbClient` (whose real `close`
 * the pool calls in `closeAll`) plus a stable no-op-close wrapper handed to
 * callers. Caching the wrapper keeps handle identity stable across acquires.
 */
interface DaemonClientEntry {
  client: DaemonGraphDbClient;
  wrapped: GraphDbClient;
  /**
   * ONE in-memory symbol table per collection, shared by every acquire: pass-2
   * resolves cross-file calls against it, so a table per acquire loses every
   * other file's symbols and collapses method-edge resolution. Mirrors
   * `PoolEntry.symbolTable`.
   */
  symbolTable: GlobalSymbolTable;
}

export class DaemonCollectionClientCache implements DaemonCollectionClientCachePort {
  /**
   * ONE `DaemonGraphDbClient` (one socket) per (collection, process); the client
   * multiplexes requests by id. Closed in `closeAll` so the daemon's
   * per-connection refcount drops and its idle watcher can release the RW lock.
   */
  private readonly daemonClients = new Map<string, DaemonClientEntry>();
  /** In-flight daemon-client init so concurrent first-callers share one socket. */
  private readonly daemonInflight = new Map<string, Promise<DaemonClientEntry>>();

  constructor(
    private readonly options: DaemonCollectionClientCacheOptions,
    private readonly connector: DaemonBuildHandshakeConnector,
  ) {}

  /**
   * Handle over the ONE cached `DaemonGraphDbClient` for the collection. Its
   * `close()` is a no-op: the pool owns the socket (`closeAll`), and a caller's
   * `finally` close must not tear it down under other in-flight callers.
   */
  async acquireHandle(physicalCollectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    const entry = await this.acquireDaemonClient(physicalCollectionName);
    return { graphDb: entry.wrapped, symbolTable: entry.symbolTable };
  }

  /**
   * Lazily create + init the single cached `DaemonGraphDbClient` for a
   * collection (plus its stable no-op-close wrapper). Concurrent first-callers
   * share one init pass via `daemonInflight`.
   */
  private async acquireDaemonClient(physicalCollectionName: PhysicalCollectionName): Promise<DaemonClientEntry> {
    const cached = this.daemonClients.get(physicalCollectionName);
    if (cached?.client.isConnected()) return cached;
    if (cached) {
      // A cached client routinely outlives its daemon (30s idle exit). Drop it
      // and cold-spawn: `respawn` is single-flighted and alive-checked, so it is
      // a no-op when a daemon is in fact running.
      this.daemonClients.delete(physicalCollectionName);
      this.options.daemonRestart?.respawn?.();
    }
    const inflight = this.daemonInflight.get(physicalCollectionName);
    if (inflight) return inflight;

    const target = this.options.daemonClientTarget?.();
    const socketPath = target?.paths.socketPath ?? this.options.daemonSocketPath;
    /* v8 ignore next -- acquireDaemonClient is only reached in daemon mode */
    if (!socketPath) throw new Error("acquireDaemonClient called without a daemon address");
    // Nothing can be spawned from a tree that is gone, and nothing else names
    // the build that replaced it: waiting out the connect window on a socket no
    // one will create only delays the same answer (bd tea-rags-mcp-llrja).
    if (target?.addressing === "build-tree-gone" && !existsSync(socketPath)) {
      throw new CodegraphClientBuildTreeGoneError({ socketPath, loadedFingerprint: target.loadedFingerprint });
    }

    const promise = (async (): Promise<DaemonClientEntry> => {
      // One-time legacy migration (bd tea-rags-mcp-42hno): a keyed client
      // meeting a legacy-layout daemon drains it, then clears the layout. Runs
      // inside the shared inflight pass, so concurrent first-callers race it
      // once.
      if (this.options.daemonStorageDir) await this.connector.migrateLegacyDaemon(physicalCollectionName);
      const client = await this.connector.connectWithBuildHandshake(socketPath, physicalCollectionName);
      const wrapped = wrapNoopClose(client);
      // Hydrate like `openCollection`, so resolution sees symbols from files not
      // re-walked this run. Non-fatal: the table starts empty and the next ingest
      // pass repopulates it.
      const symbolTable = this.options.symbolTableFactory();
      if (this.options.initHook) {
        try {
          await this.options.initHook({ collectionName: physicalCollectionName, graphDb: wrapped, symbolTable });
        } catch (err) {
          process.stderr.write(
            `[tea-rags] codegraph daemon init-hook failed for ${physicalCollectionName}: ${(err as Error).message}\n`,
          );
        }
      }
      const entry: DaemonClientEntry = { client, wrapped, symbolTable };
      this.daemonClients.set(physicalCollectionName, entry);
      return entry;
    })().finally(() => {
      this.daemonInflight.delete(physicalCollectionName);
    });
    this.daemonInflight.set(physicalCollectionName, promise);
    return promise;
  }

  /**
   * Close every cached daemon socket — what lets the daemon's refcount reach 0
   * and its idle watcher release the RW lock. Idempotent; close failures are
   * swallowed.
   */
  async closeAll(): Promise<void> {
    const daemons = [...this.daemonClients.values()];
    this.daemonClients.clear();
    await Promise.all(daemons.map(async (e) => e.client.close().catch(() => undefined)));
  }
}

/**
 * Wrap a cached `DaemonGraphDbClient` so the handle handed to a caller has a
 * NO-OP `close()`. Every other method/property forwards to the real client.
 * The pool owns the single socket per collection and closes it in `closeAll`;
 * a per-call `close()` (e.g. `GraphFacade.withReadHandle`'s `finally`) must NOT
 * tear down the shared socket out from under other in-flight callers.
 */
function wrapNoopClose(client: DaemonGraphDbClient): GraphDbClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "close") {
        return async (): Promise<void> => undefined;
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
