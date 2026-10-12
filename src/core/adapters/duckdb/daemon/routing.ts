/**
 * `createDaemonRouting` — the one constructor of a `DaemonRouting` (bd
 * tea-rags-mcp-89k7k.35, H4a3). A `GraphDbClientPool` in daemon mode consumes
 * the routing through `GraphDbClientPoolOptions.daemonRouting` and constructs
 * none of the classes here itself; every composition root (the bootstrap
 * factory, the worker-side codegraph runtime) and every test that wires a
 * daemon-mode pool builds it through THIS function, so the wiring stays in one
 * place and the duckdb root keeps zero `daemon/` imports.
 *
 * The options are the ones that used to sit on `GraphDbClientPoolOptions`:
 * `daemonStorageDir` (legacy-layout migration, bd tea-rags-mcp-42hno) and
 * `daemonRestart` (build + capability handshake restart, bd
 * tea-rags-mcp-ji56r) feed the handshake connector; the addressing and the
 * symbol-table hydration feed the client cache.
 */

import type { DaemonRouting } from "../daemon-ports.js";
import { DaemonBuildHandshakeConnector } from "./build-handshake-connector.js";
import { DaemonCollectionClientCache, type DaemonCollectionClientCacheOptions } from "./collection-client-cache.js";
import { DaemonDatabaseFileReplacer } from "./database-file-replacer.js";

export type { DaemonCollectionClientCacheOptions };

/** Build the routing a daemon-mode pool consumes from the daemon wiring options. */
export function createDaemonRouting(options: DaemonCollectionClientCacheOptions): DaemonRouting {
  return {
    clients: new DaemonCollectionClientCache(
      options,
      new DaemonBuildHandshakeConnector(options.daemonRestart, options.daemonStorageDir),
    ),
    replacerFor: (socketPath) => new DaemonDatabaseFileReplacer(socketPath),
  };
}
