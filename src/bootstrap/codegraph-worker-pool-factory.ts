/**
 * The bootstrap-owned codegraph worker POOL factory (bd tea-rags-mcp-89k7k.35,
 * S15 / H-D2=a). Constructing the per-collection DuckDB pool — and, in daemon
 * mode, its `DaemonRouting` — is a composition decision, so it lives HERE and
 * is injected by MODULE PATH (`CodegraphWorkerConfig.poolFactoryModulePath`,
 * wired by `src/bootstrap/factory.ts`): the codegraph runtime that rebuilds a
 * provider from plain data (the enrichment worker, the working-tree graph
 * build child) dynamic-imports this module and calls
 * `createCodegraphWorkerPool` — a function cannot cross `postMessage` or the
 * child's IPC boundary, and the runtime that rebuilds in another thread or
 * process is out of the static import graph's reach
 * (`.claude/rules/domains-language.md` §2 — inject a path, never an instance).
 *
 * The domain (`trajectory/codegraph/factory.ts`) consumes the pool through the
 * contracts `GraphDbClientPoolPort` and constructs no duckdb class; this module
 * imports no domain module directly (the symbol table arrives through the
 * narrow `core/api/entry-points/codegraph-worker-pool.ts`, never the api
 * assembly barrel — this module loads in every worker, per the bootstrap
 * import-direction pin).
 */

import { createDaemonRouting } from "../core/adapters/duckdb/daemon/index.js";
import { GraphDbClientPool } from "../core/adapters/duckdb/index.js";
import {
  InMemoryGlobalSymbolTable,
  type CodegraphWorkerConfig,
} from "../core/api/entry-points/codegraph-worker-pool.js";
import type { DatabaseMigrationApplier } from "../core/contracts/types/migration.js";
import { hydrateCodegraphSymbolTable } from "./codegraph-symbol-table-hydration.js";

/**
 * Build the per-collection pool a codegraph worker runtime reads and writes
 * through — the construction that used to sit inside the domain factory.
 *
 * `config.daemonSocketPath` set (the enrichment worker shape): the pool routes
 * through the multi-client daemon, and the daemon routing is built here — a
 * domain may not import the daemon classes to build it. Absent (test fixtures,
 * the working-tree build's private clone): a direct-mode pool holding the only
 * client.
 */
export async function createCodegraphWorkerPool(config: CodegraphWorkerConfig): Promise<GraphDbClientPool> {
  const migrations = (await import(config.migrationsModulePath)) as {
    createDatabaseMigrationApplier: () => DatabaseMigrationApplier;
  };
  const symbolTableFactory = (): InMemoryGlobalSymbolTable => new InMemoryGlobalSymbolTable();
  // Hydrate the per-collection symbol table from disk on first open — the same
  // hook as `wireCodegraph`'s main-thread pool.
  return new GraphDbClientPool({
    rootDir: config.rootDir,
    symbolTableFactory,
    applyMigrations: migrations.createDatabaseMigrationApplier(),
    resources: {
      memoryLimit: config.dbMemoryLimit,
      threads: config.dbThreads,
      preserveInsertionOrder: false,
    },
    daemonSocketPath: config.daemonSocketPath,
    // Daemon-mode wiring: the routing (cached clients + replacer) the pool
    // consumes. Worker pools carry no `daemonStorageDir` / `daemonRestart`
    // (provisioning ran on the main thread; respawn is wired there), so the
    // routing is built from the socket alone.
    ...(config.daemonSocketPath !== undefined
      ? {
          daemonRouting: createDaemonRouting({
            symbolTableFactory,
            initHook: hydrateCodegraphSymbolTable,
            daemonSocketPath: config.daemonSocketPath,
          }),
        }
      : {}),
    initHook: hydrateCodegraphSymbolTable,
  });
}
