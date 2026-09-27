/**
 * Asks the running codegraph daemon to replace a collection's database file —
 * remove it, or clone another collection over it — under the daemon pool's path
 * lease (bd tea-rags-mcp-r4veq).
 *
 * In daemon mode the clients live in the daemon. A process outside it that
 * unlinks or publishes the file itself replaces it under those clients, and a
 * daemon-side op already running on the old client keeps writing; DuckDB
 * addresses the WAL by path, so the rows replay into the successor. Only the
 * pool that holds the clients can drain them, so the replacement is sent there.
 *
 * The daemon is never spawned for this: a daemon that is not running holds no
 * client, and the caller's own file path is then already safe. The answer says
 * who is to do the work, never both.
 */

import { dirname } from "node:path";

import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import { isDebug } from "../../../infra/runtime.js";
import { CodegraphDaemonUnreachableError } from "../errors.js";
import { DaemonGraphDbClient } from "./client.js";
import { daemonPathsForKeyDir, isDaemonPidAlive, readDaemonPid } from "./lifecycle.js";

/**
 * Connect bound for the control connection. The pid file already says a daemon
 * is up, so its socket accepts at once; a longer wait only delays the fallback.
 */
const CONTROL_CONNECT_TIMEOUT_MS = 1_500;

/**
 * Who replaced the file. `caller` means the daemon did nothing and the caller
 * must act on the files itself:
 * - `no-daemon` — no daemon of this build is running, so no client to drain.
 * - `daemon-unreachable` — its pid is alive but its socket did not accept.
 * - `op-unsupported` — a daemon from an older build without the op.
 */
export type DaemonDatabaseReplacement =
  | { handledBy: "daemon"; evicted: boolean }
  | { handledBy: "caller"; reason: "no-daemon" | "daemon-unreachable" | "op-unsupported" };

export class DaemonDatabaseFileReplacer {
  constructor(
    /** The socket of THIS build's daemon; its lifecycle files sit beside it. */
    private readonly socketPath: string,
  ) {}

  /** Remove `target`'s database through the daemon's pool. */
  async removeDatabase(target: PhysicalCollectionName): Promise<DaemonDatabaseReplacement> {
    return this.withDaemon(target, async (client) => {
      const evicted = await client.removeCollectionDatabase(target);
      return evicted === undefined ? undefined : { handledBy: "daemon", evicted };
    });
  }

  /** Clone `source`'s database over `target` through the daemon's pool. */
  async cloneDatabase(
    source: PhysicalCollectionName,
    target: PhysicalCollectionName,
  ): Promise<DaemonDatabaseReplacement> {
    return this.withDaemon(target, async (client) =>
      (await client.cloneCollectionDatabase(source, target)) ? { handledBy: "daemon", evicted: false } : undefined,
    );
  }

  /**
   * Run `replace` over a short-lived control connection, or report why the
   * caller has to act itself. `replace` answers `undefined` for a daemon that
   * lacks the op. A failure the daemon reports for the replacement itself —
   * a client that would not close, an I/O error — propagates: the file may be
   * half-way, and acting on it again from outside would not make that safer.
   */
  private async withDaemon(
    collection: PhysicalCollectionName,
    replace: (client: DaemonGraphDbClient) => Promise<DaemonDatabaseReplacement | undefined>,
  ): Promise<DaemonDatabaseReplacement> {
    const pid = readDaemonPid(daemonPathsForKeyDir(dirname(this.socketPath)));
    if (pid === undefined || !isDaemonPidAlive(pid)) return { handledBy: "caller", reason: "no-daemon" };
    const client = new DaemonGraphDbClient(this.socketPath, collection, {
      connectTimeoutMs: CONTROL_CONNECT_TIMEOUT_MS,
    });
    try {
      await client.init();
    } catch (err) {
      if (!(err instanceof CodegraphDaemonUnreachableError)) throw err;
      if (isDebug()) {
        process.stderr.write(
          `[tea-rags] codegraph: daemon pid ${pid} is alive but ${this.socketPath} did not accept — replacing ` +
            `${collection}'s database from this process (bd tea-rags-mcp-r4veq)\n`,
        );
      }
      return { handledBy: "caller", reason: "daemon-unreachable" };
    }
    try {
      return (await replace(client)) ?? { handledBy: "caller", reason: "op-unsupported" };
    } finally {
      await client.close();
    }
  }
}
