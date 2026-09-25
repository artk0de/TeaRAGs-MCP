// src/bootstrap/transport/stdio.ts
import type { EventEmitter } from "node:events";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** Upper bound on how long shutdown waits for cleanup before exiting anyway. */
const STDIO_SHUTDOWN_CLEANUP_TIMEOUT_MS = 5_000;

export interface StdioShutdownOptions {
  /** Releases the process's resources — `AppContext#cleanup`. */
  cleanup?: () => void | Promise<void>;
  /** Stream whose end means the client is gone. Defaults to `process.stdin`. */
  stdin?: EventEmitter;
  /** Source of SIGTERM / SIGINT. Defaults to `process`. */
  signals?: EventEmitter;
  /** Terminates the process. Defaults to `process.exit`. */
  exit?: (code: number) => never;
  /** Cleanup budget; the process exits when it runs out. */
  cleanupTimeoutMs?: number;
}

/**
 * bd tea-rags-mcp-e6cpu — a stdio MCP server lives exactly as long as its
 * client's pipe. When stdin ends or closes, or SIGTERM / SIGINT arrives:
 * release resources (daemon refcounts, DuckDB pools, git children, the
 * registry watcher), then EXIT. Registering a signal listener disables Node's
 * default exit-on-signal, and a closed stdin is not noticed by the MCP stdio
 * transport at all — without this, in-flight indexing kept the orphaned server
 * alive, spawning VCS children for a client that no longer exists.
 *
 * Runs once whichever trigger fires first; a throwing or hanging cleanup still
 * ends in `exit(0)`, bounded by `cleanupTimeoutMs`. Returns the shutdown
 * routine so a caller can trigger it directly.
 */
export function installStdioShutdown(options: StdioShutdownOptions = {}): () => Promise<void> {
  const {
    cleanup,
    stdin = process.stdin,
    signals = process,
    exit = process.exit.bind(process),
    cleanupTimeoutMs = STDIO_SHUTDOWN_CLEANUP_TIMEOUT_MS,
  } = options;

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    shutdownPromise ??= (async () => {
      await releaseWithin(cleanup, cleanupTimeoutMs);
      exit(0);
    })();
    return shutdownPromise;
  };
  const trigger = (): void => {
    void shutdown();
  };

  stdin.on("end", trigger);
  stdin.on("close", trigger);
  signals.on("SIGTERM", trigger);
  signals.on("SIGINT", trigger);
  return shutdown;
}

/**
 * Run `cleanup` (an `AppContext#cleanup`), waiting at most `timeoutMs`; a
 * throwing cleanup is reported on stderr, never rethrown. Shared by every
 * shutdown path that must end the process promptly — the stdio server and the
 * one-shot in-process session behind `tea-rags call`.
 */
export async function releaseWithin(
  cleanup: (() => void | Promise<void>) | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!cleanup) return;
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const released = (async () => {
    try {
      await cleanup();
    } catch (error) {
      console.error("[tea-rags] cleanup failed during shutdown:", error);
    }
  })();
  try {
    await Promise.race([released, budget]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startStdioServer(server: McpServer, shutdown: StdioShutdownOptions = {}): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  installStdioShutdown(shutdown);
  console.error("Qdrant MCP server running on stdio");
}
