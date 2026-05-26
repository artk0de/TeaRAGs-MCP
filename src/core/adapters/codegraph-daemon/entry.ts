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
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { pathToFileURL } from "node:url";

import { InMemoryGlobalSymbolTable } from "../../domains/trajectory/codegraph/symbols/symbol-table.js";
import { GraphDbClientPool } from "../duckdb/pool.js";
import {
  type CodegraphDaemonPaths,
  decrementRefs,
  getDaemonPaths,
  getStorageDir,
  incrementRefs,
  scheduleIdleWatcher,
} from "./lifecycle.js";
import { decodeFrames, encodeFrame, type DaemonRequest } from "./protocol.js";
import { CodegraphDaemonServer } from "./server.js";

export interface DaemonRuntimeOptions {
  /** Root directory for per-collection DuckDB files (`<rootDir>/codegraph/`). */
  rootDir: string;
  /** Lifecycle file locations (socket/pid/refs/lock). */
  paths: CodegraphDaemonPaths;
  /** DuckDB resource ceiling mirrored from the bootstrap pool options. */
  resources?: {
    memoryLimit?: string;
    threads?: number;
    preserveInsertionOrder?: boolean;
  };
}

/**
 * Build the per-connection `data`/`close` handler pair for a socket. Extracted
 * so tests can drive framing + refcounting without a live `net.Server`.
 */
export function createConnectionHandler(
  server: CodegraphDaemonServer,
  paths: CodegraphDaemonPaths,
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
  const pool = new GraphDbClientPool({
    rootDir: options.rootDir,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    resources: options.resources,
    // NO daemonSocketPath — this process IS the daemon; its pool holds the
    // single RW DuckDB connection in-process.
    initHook: async ({ graphDb, symbolTable }) => {
      const persisted = await graphDb.listAllSymbols();
      if (persisted.length > 0) symbolTable.hydrate(persisted);
    },
  });
  const handler = new CodegraphDaemonServer(pool);
  const server = createServer(createConnectionHandler(handler, options.paths));

  // Holder so `shutdown` can clear the watcher that is armed after it is
  // defined (avoids a forward-referenced `let` that prefer-const flags).
  const watcherRef: { current?: NodeJS.Timeout } = {};
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (watcherRef.current) clearInterval(watcherRef.current);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await pool.closeAll().catch(() => undefined);
    cleanupDaemonFiles(options.paths);
  };

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
  watcherRef.current = scheduleIdleWatcher(options.paths, () => {
    void shutdown().then(() => process.exit(0));
  });

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
  const threadsRaw = process.env.TEA_RAGS_CODEGRAPH_DAEMON_THREADS;
  return {
    rootDir,
    paths,
    resources: {
      memoryLimit,
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
