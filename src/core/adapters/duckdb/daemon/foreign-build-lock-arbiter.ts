/**
 * Settles a DuckDB open that lost the file lock to the codegraph daemon of
 * ANOTHER build (bd tea-rags-mcp-hw27k).
 *
 * Build-keyed daemons (bd tea-rags-mcp-42hno) never share a socket, so two
 * builds on one machine run two daemons over the same collection files. The
 * daemon pool's bounded open retry waits for the holder's per-collection idle
 * eviction (nlls); a holder that keeps being used never gets there, and every
 * op then waited the whole window and failed with a bare open error — 629.7 s
 * of fileFinalize on taxdome, 2026-09-27.
 *
 * The driver names the lock holder's pid. When that pid owns a build-key
 * directory other than ours, the holder is a foreign codegraph daemon, and:
 *
 * - with NO client connected (its refs count is zero) it serves nobody right
 *   now, so it is drained through the ordinary `shutdown` op — the same drain
 *   the build handshake uses, still refused by the daemon while a write is in
 *   flight (bd tea-rags-mcp-zgcmo). Its own sessions respawn it on their next
 *   acquire, as they do after an idle exit;
 * - with a client connected it is left alone: draining it would cut a session
 *   of that build mid-use, and a daemon of this build meeting OUR run's daemon
 *   would drain it back between two writes — the livelock the handshake's
 *   bounded restart exists to avoid (bd tea-rags-mcp-ryoqn). The caller keeps
 *   its bounded wait and then names the holder.
 *
 * A holder that is not a registered daemon (another process, a legacy layout)
 * is not this arbiter's business: the caller keeps its plain retry.
 *
 * Residual race, accepted: a client may connect between the refs read and the
 * drain. Its in-flight request is lost with the connection, which the client's
 * crash-recovery hook (bd tea-rags-mcp-8l8d3) respawns and replays.
 */

import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import { isDebug } from "../../../infra/runtime.js";
import { isDaemonDrainRefusal, type DuckDbOpenFailedError, type ForeignBuildDaemonLockHolder } from "../errors.js";
import { DaemonGraphDbClient } from "./client.js";
import {
  daemonPathsForKeyDir,
  listDaemonKeyDirs,
  readRefs,
  waitForDaemonExit,
  type DaemonKeyDirStatus,
} from "./lifecycle.js";

/** Connect bound for the control connection: the pid file says the daemon is up. */
const CONTROL_CONNECT_TIMEOUT_MS = 1_500;
/** The daemon's own drain is hard-capped at ~3 s (`createShutdown`). */
const DEFAULT_EXIT_TIMEOUT_MS = 10_000;

/** How a lock held by another build's daemon was settled. */
export type ForeignBuildLockSettlement =
  /** The holder is not a codegraph daemon of another build — plain retry applies. */
  | { kind: "notForeignBuildDaemon" }
  /** The holder served nobody and has exited; the open may be retried at once. */
  | { kind: "drained"; holder: ForeignBuildDaemonLockHolder }
  /** The holder is in use, refused the drain, or could not be drained; it stays up. */
  | {
      kind: "held";
      holder: ForeignBuildDaemonLockHolder;
      reason: "clientConnected" | "drainRefused" | "unreachable" | "exitTimeout";
    };

export interface ForeignBuildDaemonLockArbiterOptions {
  /** Base daemon storage dir — the parent of every build-key directory. */
  storageDir: string;
  /** THIS daemon's build-key directory, never treated as foreign. */
  ownBuildDir: string;
  /** This build's fingerprint: the handshake learns the holder's without opening anything. */
  buildFingerprint: string;
  /** Bound on the drained daemon's exit. */
  exitTimeoutMs?: number;
}

export class ForeignBuildDaemonLockArbiter {
  constructor(private readonly options: ForeignBuildDaemonLockArbiterOptions) {}

  /**
   * Settle `openError` — a lock-contention open failure of `collection` —
   * against its holder. Reads a few lifecycle files; connects to the holder
   * only to drain it.
   */
  async settle(
    openError: DuckDbOpenFailedError,
    collection: PhysicalCollectionName,
  ): Promise<ForeignBuildLockSettlement> {
    const pid = openError.lockHolderPid;
    if (pid === undefined) return { kind: "notForeignBuildDaemon" };
    const status = listDaemonKeyDirs(this.options.storageDir).find(
      (s) => s.alive && s.pid === pid && s.keyDir !== this.options.ownBuildDir,
    );
    if (!status) return { kind: "notForeignBuildDaemon" };

    const holder: ForeignBuildDaemonLockHolder = { pid, buildDir: status.keyDir, buildFingerprint: undefined };
    // Read BEFORE connecting: our own control connection counts as a client.
    if (readRefs(status.paths) > 0) return { kind: "held", holder, reason: "clientConnected" };
    return this.drain(status, holder, collection);
  }

  /**
   * The holder with its build fingerprint filled in over a short control
   * connection, for naming it in an error. A handshake from another build
   * opens nothing on the daemon's side. Best-effort: an unreachable socket
   * leaves the fingerprint unknown.
   */
  async describe(
    holder: ForeignBuildDaemonLockHolder,
    collection: PhysicalCollectionName,
  ): Promise<ForeignBuildDaemonLockHolder> {
    if (holder.buildFingerprint !== undefined) return holder;
    const client = this.controlClient(holder.buildDir, collection);
    try {
      await client.init();
      return { ...holder, buildFingerprint: (await client.handshake(this.options.buildFingerprint))?.buildFingerprint };
    } catch {
      return holder;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * Drain an idle holder the way `GraphDbClientPool#drainStaleDaemon` drains a
   * stale one: request the shutdown, close our socket, poll its lifecycle
   * files for the exit. A refusal (a write in flight) and a failed exit keep it
   * `held`; a socket that does not accept is `unreachable` — the file stays
   * held, so the caller must not retry at once.
   */
  private async drain(
    status: DaemonKeyDirStatus,
    holder: ForeignBuildDaemonLockHolder,
    collection: PhysicalCollectionName,
  ): Promise<ForeignBuildLockSettlement> {
    const client = this.controlClient(status.keyDir, collection);
    try {
      await client.init();
    } catch {
      await client.close().catch(() => undefined);
      return { kind: "held", holder, reason: "unreachable" };
    }
    let described = holder;
    try {
      const handshake = await client.handshake(this.options.buildFingerprint).catch(() => null);
      described = { ...holder, buildFingerprint: handshake?.buildFingerprint };
      await client.requestShutdown();
    } catch (err) {
      // Any other shutdown failure keeps the poll below, whose timeout names a
      // wedge — the same rule the handshake's drain follows.
      if (isDaemonDrainRefusal(err)) {
        await client.close().catch(() => undefined);
        return { kind: "held", holder: described, reason: "drainRefused" };
      }
    }
    await client.close().catch(() => undefined);
    if (isDebug()) {
      process.stderr.write(
        `[tea-rags] codegraph: drained idle daemon pid ${holder.pid} of another build (${status.keyDir}) — it held ` +
          `${collection}'s database file and no client was connected (bd tea-rags-mcp-hw27k)\n`,
      );
    }
    const exited = await waitForDaemonExit(status.paths, holder.pid, {
      timeoutMs: this.options.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS,
    });
    return exited ? { kind: "drained", holder: described } : { kind: "held", holder: described, reason: "exitTimeout" };
  }

  private controlClient(keyDir: string, collection: PhysicalCollectionName): DaemonGraphDbClient {
    return new DaemonGraphDbClient(daemonPathsForKeyDir(keyDir).socketPath, collection, {
      connectTimeoutMs: CONTROL_CONNECT_TIMEOUT_MS,
    });
  }
}
