/**
 * DuckDB adapter errors. Lives at the adapter layer per
 * `.claude/rules/domain-boundaries.md` — adapter wraps external driver
 * failures into typed `InfraError` subclasses; consumers (bootstrap
 * pool, codegraph trajectory) catch / re-throw without leaking raw
 * driver messages.
 */

import { InfraError } from "../errors.js";

/**
 * DuckDB file open / initialisation failed — usually a concurrent
 * tea-rags process holding the file lock (DuckDB is single-writer per
 * file), but also surfaces I/O errors (permission denied, missing
 * directory, corrupted file). The pool catches this to degrade
 * gracefully: the offending collection runs without codegraph until
 * the lock is released or the file is repaired.
 */
export class DuckDbOpenFailedError extends InfraError {
  constructor(dbPath: string, cause?: Error) {
    super({
      code: "INFRA_DUCKDB_OPEN_FAILED",
      message: `Failed to open DuckDB at ${dbPath}`,
      hint:
        "DuckDB is single-writer per file. Another tea-rags MCP process likely holds the lock — " +
        "stop the duplicate server or wait for it to idle out, then retry. Codegraph for this " +
        "collection is disabled in this process until the lock is released.",
      httpStatus: 503,
      cause,
    });
  }
}

/**
 * The codegraph daemon still presents a DIFFERENT build fingerprint after the
 * single drain-restart retry (bd tea-rags-mcp-ji56r). Usually another live
 * session keeps cold-spawning the daemon from ITS build — a transient during
 * parallel-worktree testing — or the respawn hook launched a stale binary.
 */
export class CodegraphDaemonStaleBuildError extends InfraError {
  constructor(socketPath: string, clientFingerprint: string, daemonFingerprint: string, cause?: Error) {
    super({
      code: "INFRA_CODEGRAPH_DAEMON_STALE_BUILD",
      message:
        `Codegraph daemon at ${socketPath} still runs a different build after a restart ` +
        `(daemon=${daemonFingerprint}, client=${clientFingerprint})`,
      hint:
        "A parallel tea-rags session is likely respawning the daemon from another build " +
        "(npm link points elsewhere). Retry once the other session finishes, or re-run " +
        "`npm run build && npm link` so both sessions share one build.",
      httpStatus: 503,
      cause,
    });
  }
}

/**
 * The stale codegraph daemon acknowledged the graceful `shutdown` request but
 * did not exit within the wait window — its lifecycle files never cleared and
 * its pid stayed alive (bd tea-rags-mcp-ji56r). The daemon's own teardown is
 * hard-capped at ~3s, so exceeding the window means a wedged process.
 */
export class CodegraphDaemonExitTimeoutError extends InfraError {
  constructor(socketPath: string, timeoutMs: number, cause?: Error) {
    super({
      code: "INFRA_CODEGRAPH_DAEMON_EXIT_TIMEOUT",
      message: `Stale codegraph daemon at ${socketPath} did not exit within ${timeoutMs}ms after a shutdown request`,
      hint:
        "The daemon process appears wedged and still holds the RW DuckDB lock. Inspect it " +
        "via the pid file next to the socket and stop it manually; a fresh daemon spawns on " +
        "the next write.",
      httpStatus: 503,
      cause,
    });
  }
}

/**
 * DuckDB connection close failed while evicting a cached pool entry.
 * Distinct from open failure: the file already exists and the driver
 * rejected the close (rare — usually a hung connection). Unlink errors
 * are NOT surfaced as this class; they are swallowed by the pool because
 * `removeCollection` is idempotent and ENOENT means "already gone".
 */
export class DuckDbCloseFailedError extends InfraError {
  constructor(dbPath: string, cause?: Error) {
    super({
      code: "INFRA_DUCKDB_CLOSE_FAILED",
      message: `Failed to close DuckDB at ${dbPath}`,
      hint:
        "The DuckDB driver rejected the close call. Codegraph DB file may still be " +
        "locked until the process exits. Inspect cause for the underlying driver message.",
      httpStatus: 500,
      cause,
    });
  }
}
