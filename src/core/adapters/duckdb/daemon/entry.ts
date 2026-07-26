/**
 * Codegraph daemon process entrypoint.
 *
 * Spawned (detached) by the bootstrap factory's `ensureCodegraphDaemon` when
 * `TEA_RAGS_CODEGRAPH_DAEMON=1`. The daemon owns the single read-write
 * `GraphDbClientPool` for the machine — every MCP client process proxies
 * mutations to it over the unix socket, so the cross-process single-writer
 * DuckDB lock is held by exactly one process. Reads bypass the daemon entirely
 * (in-process READ_ONLY attach via `pool.acquireRead`).
 *
 * Transport: newline-delimited JSON over a unix socket (`encodeFrame` /
 * `decodeFrames`). Each connection increments the file refcount on connect and
 * decrements on close; once the refcount has stayed at 0 for `IDLE_SHUTDOWN_MS`
 * the idle watcher tears the daemon down (close server → close pool → unlink
 * lifecycle files → exit), releasing the RW lock for the next cold spawn.
 *
 * The module is importable without side effects — the server only starts when
 * the file is executed directly as the process main (`runDaemon()` guarded by
 * the `import.meta.url === pathToFileURL(argv[1])` check at the bottom). Tests
 * import `runDaemon` / `createConnectionHandler` and drive them explicitly.
 */

import { unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { pathToFileURL } from "node:url";

import type { MigrationCapableGraphClient } from "../../../contracts/types/migration.js";
import { GraphDbClientPool } from "../pool.js";
import {
  decrementRefs,
  getDaemonPaths,
  getStorageDir,
  incrementRefs,
  scheduleIdleWatcher,
  type CodegraphDaemonPaths,
} from "./lifecycle.js";
import { DaemonMemoryGovernor, DEFAULT_MEMORY_LIMIT_BASE, DEFAULT_MEMORY_LIMIT_MAX } from "./memory-governor.js";
import { NoopGlobalSymbolTable } from "./noop-symbol-table.js";
import { decodeFrames, encodeFrame, type DaemonRequest } from "./protocol.js";
import { CodegraphDaemonServer } from "./server.js";

export interface DaemonRuntimeOptions {
  /** Root directory for per-collection DuckDB files (`<rootDir>/codegraph/`). */
  rootDir: string;
  /**
   * URL of the module exporting `runMigrations` + `DATABASE_MIGRATIONS`
   * (`domains/maintenance/migration/database/index.js`).
   *
   * The daemon holds the single RW connection and creates graph databases, so
   * it must apply the DDL itself — but it lives in `adapters`, which may not
   * import a domain. The spawner passes the URL and the daemon imports it
   * in-process: the module-path DI pattern the worker threads already use.
   */
  migrationsModulePath: string;
  /** Lifecycle file locations (socket/pid/refs/lock). */
  paths: CodegraphDaemonPaths;
  /** DuckDB resource ceiling mirrored from the bootstrap pool options. */
  resources?: {
    memoryLimit?: string;
    /**
     * Adaptive-governor ceiling (bd tea-rags-mcp-1ruih): the memory_limit the
     * daemon may raise to during a bulk-ingest write burst. Consumed by the
     * `DaemonMemoryGovernor` only — the pool keeps opening connections at the
     * base `memoryLimit`.
     */
    memoryLimitMax?: string;
    threads?: number;
    preserveInsertionOrder?: boolean;
  };
  /**
   * Build identity handed to the `CodegraphDaemonServer` for the handshake
   * (bd tea-rags-mcp-ji56r). Tests inject a forced value; a real daemon
   * process defaults to the module-computed fingerprint (env-overridable via
   * TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT).
   */
  buildFingerprint?: string;
  /**
   * Process-exit hook invoked after the graceful drain completes — both by
   * the idle watcher and by a client-requested `shutdown` op. Defaults to
   * `process.exit`; tests running the daemon IN-PROCESS inject a no-op so the
   * drain path cannot kill the test runner.
   */
  exit?: (code: number) => void;
}

/** Hard ceiling on graceful teardown before the daemon force-exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 3_000;

export interface ShutdownDeps {
  /** The net server to stop accepting on (its `close(cb)` may hang). */
  server: Pick<Server, "close">;
  /** Pool whose cached clients/files must be closed (its `closeAll` may hang). */
  pool: Pick<GraphDbClientPool, "closeAll">;
  /** Sync lifecycle-file cleanup, always run after the bounded teardown. */
  cleanup: () => void;
  /** Override the hard timeout (tests pass a tiny value). */
  timeoutMs?: number;
}

/**
 * Build the daemon's single graceful-shutdown function. Both the idle watcher
 * AND the SIGTERM/SIGINT handlers call it. The teardown (stop accepting, close
 * the pool's cached daemon clients + DuckDB files) is wrapped in a hard timeout
 * (`Promise.race`) so a wedged DuckDB driver close or a server that never fires
 * its close callback can NEVER keep the process alive — the lock-leak root
 * cause 2 ("daemon ignored SIGTERM, needed SIGKILL"). After the race resolves
 * (cleanly or via timeout) the lifecycle files are unlinked and the caller
 * force-exits. Idempotent: a second call is a no-op.
 */
export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  const timeoutMs = deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let shuttingDown = false;
  return async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    const teardown = (async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        deps.server.close(() => {
          resolve();
        });
      });
      await deps.pool.closeAll().catch(() => undefined);
    })();

    // Race the teardown against a bounded timer. A hung teardown loses the race
    // but does not block — `cleanup` + force-exit happen regardless.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      void teardown.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });

    deps.cleanup();
  };
}

export interface IdleShutdownDeps {
  /** Memory governor whose `onIdle` restores the base memory_limit. */
  governor: Pick<DaemonMemoryGovernor, "onIdle">;
  /** The daemon's bounded graceful shutdown (see `createShutdown`). */
  shutdown: () => Promise<void>;
  /** Process exit, injectable for tests. */
  exit: () => void;
}

/**
 * Build the idle-watcher callback: restore the base DuckDB memory_limit on
 * every burst-raised collection BEFORE the shutdown releases the RW lock, so
 * the next opener never inherits a file whose live connection was still at
 * the ingest ceiling. Lowering is best-effort — a rejecting `onIdle` never
 * blocks the shutdown + exit path (the lock release is the priority).
 */
export function createIdleShutdown(deps: IdleShutdownDeps): () => void {
  return () => {
    void deps.governor
      .onIdle()
      .catch(() => undefined)
      .then(async () => deps.shutdown())
      .then(() => {
        deps.exit();
      });
  };
}

/**
 * Build the per-connection `data`/`close` handler pair for a socket. Extracted
 * so tests can drive framing + refcounting without a live `net.Server`.
 */
export function createConnectionHandler(
  server: CodegraphDaemonServer,
  paths: CodegraphDaemonPaths,
  /**
   * Invoked when a client sends the `shutdown` op (its build fingerprint
   * differs from this daemon's — bd tea-rags-mcp-ji56r). Wired by `runDaemon`
   * to the SAME drain/exit lambda the idle watcher uses, so there is exactly
   * one teardown path. The ack is written BEFORE the drain starts so the
   * requesting client can await confirmation, then close its socket and poll
   * the lifecycle files for the actual exit.
   */
  onShutdownRequest?: () => void,
): (sock: Socket) => void {
  return (sock: Socket) => {
    incrementRefs(paths);
    let buf = "";
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const frame of frames) {
        const req = JSON.parse(frame) as DaemonRequest;
        if (req.op === "shutdown") {
          if (!sock.destroyed) sock.write(encodeFrame({ id: req.id, ok: true, result: null }));
          onShutdownRequest?.();
          continue;
        }
        void server.handle(req).then((res) => {
          if (!sock.destroyed) sock.write(encodeFrame(res));
        });
      }
    });
    sock.on("close", () => {
      decrementRefs(paths);
    });
    // A socket error (peer crash) is treated like a close — never crash the
    // daemon over one bad client connection.
    sock.on("error", () => {
      sock.destroy();
    });
  };
}

/**
 * Start the daemon: construct the RW pool + server, listen on the socket, write
 * the pid file, and arm the idle watcher. Resolves once the socket is listening
 * (the process then stays alive on the open server handle). Returns the server
 * + a `shutdown` so tests can tear it down deterministically.
 */
export async function runDaemon(
  options: DaemonRuntimeOptions,
): Promise<{ server: Server; shutdown: () => Promise<void> }> {
  // Same reason the symbol table is injected: the DDL steps live in a domain
  // this layer may not import, so they arrive as a module URL and are loaded
  // in-process here.
  const { runMigrations, DATABASE_MIGRATIONS } = (await import(options.migrationsModulePath)) as {
    runMigrations: (client: MigrationCapableGraphClient, migrations: unknown[]) => Promise<unknown>;
    DATABASE_MIGRATIONS: unknown[];
  };
  const pool = new GraphDbClientPool({
    rootDir: options.rootDir,
    // The daemon never resolves call edges (resolution happens in the MCP
    // client process); it only persists already-resolved edges. So it needs no
    // real symbol table — a no-op table avoids the adapter->domain import of
    // InMemoryGlobalSymbolTable, and there is no hydrate initHook to run.
    symbolTableFactory: () => new NoopGlobalSymbolTable(),
    applyMigrations: async (client) => {
      await runMigrations(client, DATABASE_MIGRATIONS);
    },
    resources: options.resources,
    // NO daemonSocketPath — this process IS the daemon; its pool holds the
    // single RW DuckDB connection in-process.
  });
  // Adaptive memory governor (bd tea-rags-mcp-1ruih): raises memory_limit to
  // the ceiling on the first write of an ingest burst; the idle watcher
  // restores the base BEFORE releasing the RW lock (see createIdleShutdown).
  const governor = new DaemonMemoryGovernor({
    baseLimit: options.resources?.memoryLimit ?? DEFAULT_MEMORY_LIMIT_BASE,
    maxLimit: options.resources?.memoryLimitMax ?? DEFAULT_MEMORY_LIMIT_MAX,
  });
  const handler = new CodegraphDaemonServer(pool, options.buildFingerprint, governor);

  // Holders so the connection handler / `shutdown` can reference values that
  // are only constructed after them (mirrors the watcherRef pattern; avoids
  // forward-referenced `let`s that prefer-const flags). `shutdownRef` breaks
  // the construction cycle: server → connection handler → drainAndExit →
  // shutdown → boundedShutdown → server. It is assigned before `listen`, so
  // every connection observes it set.
  const watcherRef: { current?: NodeJS.Timeout } = {};
  const shutdownRef: { current?: () => Promise<void> } = {};
  // ONE drain/exit lambda shared by the idle watcher AND the client-requested
  // `shutdown` op (bd tea-rags-mcp-ji56r) — a single teardown path, no clone.
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const drainAndExit = (): void => {
    void shutdownRef.current?.().then(() => {
      exit(0);
    });
  };

  const server = createServer(createConnectionHandler(handler, options.paths, drainAndExit));
  const boundedShutdown = createShutdown({
    server,
    pool,
    cleanup: () => {
      cleanupDaemonFiles(options.paths);
    },
  });
  const shutdown = async (): Promise<void> => {
    if (watcherRef.current) clearInterval(watcherRef.current);
    await boundedShutdown();
  };
  shutdownRef.current = shutdown;

  // Clear any stale socket file left by a previously-crashed daemon. Without
  // this, `server.listen` fails with EADDRINUSE because the unix socket inode
  // still exists on disk even though no process is bound to it. Idempotent —
  // a missing file (ENOENT, the common cold-spawn case) is swallowed.
  try {
    unlinkSync(options.paths.socketPath);
  } catch {
    /* no stale socket — fresh spawn */
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.paths.socketPath, () => {
      resolve();
    });
  });

  writeFileSync(options.paths.pidFile, String(process.pid), "utf-8");
  // Idle teardown lowers the memory limit BEFORE the shared drain path
  // (1ruih); the client-requested `shutdown` op keeps the plain drainAndExit —
  // the process dies anyway, no SET needed there (ji56r).
  watcherRef.current = scheduleIdleWatcher(
    options.paths,
    createIdleShutdown({
      governor,
      shutdown,
      exit: () => {
        exit(0);
      },
    }),
  );

  return { server, shutdown };
}

/** Unlink the daemon's lifecycle files; idempotent (missing-file errors swallowed). */
function cleanupDaemonFiles(paths: CodegraphDaemonPaths): void {
  for (const f of [paths.socketPath, paths.pidFile, paths.portFile, paths.refsFile, paths.lockFile]) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

/* v8 ignore start -- process-main bootstrap; exercised only when run as a real daemon process */
/**
 * Resolve runtime options from the environment the factory's `spawn` set:
 * `TEA_RAGS_CODEGRAPH_DAEMON_ROOT` (per-collection DB root) +
 * `TEA_RAGS_CODEGRAPH_DAEMON_DIR` (lifecycle storage dir, also honoured by
 * `getStorageDir`). Resource ceilings come through the same env the parent uses.
 */
function optionsFromEnv(): DaemonRuntimeOptions {
  const rootDir = process.env.TEA_RAGS_CODEGRAPH_DAEMON_ROOT ?? process.cwd();
  const paths = getDaemonPaths(getStorageDir(rootDir));
  const memoryLimit = process.env.TEA_RAGS_CODEGRAPH_DAEMON_MEMORY;
  const memoryLimitMax = process.env.TEA_RAGS_CODEGRAPH_DAEMON_MEMORY_MAX;
  const threadsRaw = process.env.TEA_RAGS_CODEGRAPH_DAEMON_THREADS;
  const migrationsModulePath = process.env.TEA_RAGS_CODEGRAPH_DAEMON_MIGRATIONS;
  if (!migrationsModulePath) {
    // Invariant violation — the spawner always sets it (see bootstrap/factory).
    // Starting without it would open collections with no schema.
    throw new Error("TEA_RAGS_CODEGRAPH_DAEMON_MIGRATIONS is required to start the codegraph daemon");
  }
  return {
    rootDir,
    paths,
    migrationsModulePath,
    resources: {
      memoryLimit,
      memoryLimitMax,
      threads: threadsRaw ? parseInt(threadsRaw, 10) || undefined : undefined,
      preserveInsertionOrder: false,
    },
  };
}

async function main(): Promise<void> {
  const { shutdown } = await runDaemon(optionsFromEnv());
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      void shutdown().then(() => process.exit(0));
    });
  }
}

// Run only when executed directly (not when imported by tests/factory). The
// argv[1] comparison mirrors the standard ESM "is this the entrypoint" guard.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
/* v8 ignore stop */
