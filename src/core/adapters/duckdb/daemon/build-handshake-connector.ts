/**
 * Connects a client process to the codegraph daemon of the right build (bd
 * tea-rags-mcp-ji56r, 39xca.4, 1wr7p, 42hno): the build + capability handshake,
 * the bounded drain-respawn loop that replaces a stale daemon, the read-only
 * settlement when THIS process is the stale side, and the one-time migration of
 * a legacy (pre-keying) daemon layout. Split out of `GraphDbClientPool`
 * (0qaht.38), which composes it through `DaemonCollectionClientCache`.
 *
 * Every `./client.js` value is imported dynamically, so a pool in direct/test
 * mode never loads the node:net socket code.
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";

import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import { isDebug } from "../../../primitives/diagnostics/index.js";
import {
  CodegraphClientStaleBuildError,
  CodegraphDaemonBuildSkewError,
  CodegraphDaemonBuildUnavailableError,
  CodegraphDaemonDrainRefusedError,
  CodegraphDaemonExitTimeoutError,
  CodegraphDaemonStaleBuildError,
  CodegraphDaemonUnreachableError,
  isDaemonDrainRefusal,
} from "../errors.js";
import { getBuildFingerprint, readOnDiskBuildFingerprint } from "./build-fingerprint.js";
import type { DaemonCapabilityVerdict, DaemonGraphDbClient } from "./client.js";
import {
  daemonPathsForKeyDir,
  DEFAULT_EXIT_TIMEOUT_MS,
  getBuildKey,
  getLegacyDaemonPaths,
  isDaemonPidAlive,
  readDaemonPid,
  unlinkDaemonFiles,
  waitForDaemonExit,
} from "./lifecycle.js";

/**
 * Build + capability handshake restart wiring — `GraphDbClientPoolOptions.daemonRestart`
 * documents when it applies.
 */
export interface CodegraphDaemonRestartWiring {
  /** Cold-spawn hook — wired to `ensureCodegraphDaemon` by the bootstrap factory. */
  respawn?: () => void;
  /** Override the module-captured loaded fingerprint (tests). */
  buildFingerprint?: string;
  /**
   * Override the reader of the build fingerprint on disk NOW (tests) — what a
   * daemon respawned from this process's build tree would report. Defaults to
   * `readOnDiskBuildFingerprint`.
   */
  readOnDiskBuildFingerprint?: () => string | undefined;
  /** Bound on the wait for the stale daemon's exit (default 10s). */
  exitTimeoutMs?: number;
  /** Lifecycle-file poll interval while waiting for the exit. */
  pollIntervalMs?: number;
  /**
   * Drain-respawn attempts before the typed error (default 3, floor 1). Kept
   * small on purpose: it widens the window for losing a spawn race, it is not
   * a wait-until-healthy loop.
   */
  maxRestartAttempts?: number;
  /** Base delay between restart attempts; jittered (default 250ms). */
  restartDelayMs?: number;
}

/**
 * Drain-respawn attempts before `CodegraphDaemonStaleBuildError`: enough to lose
 * a spawn race to another MCP process, few enough that a respawn hook launching a
 * stale binary fails fast (bd tea-rags-mcp-ryoqn) — see `connectWithBuildHandshake`.
 */
const DEFAULT_MAX_RESTART_ATTEMPTS = 3;

/** Base delay between restart attempts; jittered per attempt. */
const DEFAULT_RESTART_DELAY_MS = 250;

/**
 * A respawn-capable pool replaces a daemon from another build, or one that does
 * not advertise every op this client requires (bd tea-rags-mcp-39xca.4).
 */
function needsDaemonReplacement(verdict: DaemonCapabilityVerdict): boolean {
  return verdict.buildMismatch || verdict.missingRequiredOps.length > 0;
}

/** Debug-line reason a handshake did not settle. */
function describeDaemonSkew(verdict: DaemonCapabilityVerdict, clientFingerprint: string): string {
  const builds = `(daemon=${verdict.daemonFingerprint ?? "unknown"}, client=${clientFingerprint})`;
  const missing =
    verdict.missingRequiredOps.length > 0 ? `lacks required ops ${verdict.missingRequiredOps.join(", ")} ` : "";
  return verdict.buildMismatch ? `build mismatch ${missing}${builds}` : `${missing}${builds}`;
}

export class DaemonBuildHandshakeConnector {
  constructor(
    private readonly restart: CodegraphDaemonRestartWiring | undefined,
    private readonly daemonStorageDir: string | undefined,
  ) {}

  /**
   * Migrate a LEGACY (pre-keying, 42hno) daemon layout out of the base
   * storage dir. The five lifecycle files sitting DIRECTLY in
   * `daemonStorageDir` belong to the one shared daemon the pre-keying builds
   * all ran; a keyed client must get them out of the way so no later spawn
   * ever considers them. A live legacy daemon is drained through the EXISTING
   * flow (`drainStaleDaemon`) — the zgcmo drain-refusal guard protects any
   * in-flight writer, and a refusal propagates as the typed retryable error.
   * A dead (or unreadable) legacy pid's files are unlinked directly. Idempotent
   * and effectively free once the layout is gone: two `existsSync` calls.
   */
  async migrateLegacyDaemon(physicalCollectionName: PhysicalCollectionName): Promise<void> {
    const dir = this.daemonStorageDir;
    /* v8 ignore next 2 -- the only caller checks the option first */
    if (!dir) return;
    const legacy = getLegacyDaemonPaths(dir);
    if (!existsSync(legacy.pidFile) && !existsSync(legacy.socketPath)) return;
    const pid = readDaemonPid(legacy);
    if (pid !== undefined && isDaemonPidAlive(pid)) {
      if (isDebug()) {
        process.stderr.write(
          `[tea-rags] codegraph: legacy (un-keyed) daemon layout found in ${dir} — draining it before ` +
            "connecting to this build's keyed daemon (bd tea-rags-mcp-42hno)\n",
        );
      }
      // A short connect bound: this daemon predates keying, and if it stopped
      // accepting between the pid probe and now, waiting out the full spawn
      // window buys nothing — the caller treats an unreachable socket as a
      // failure, which is the honest answer.
      const { DaemonGraphDbClient } = await import("./client.js");
      const client = new DaemonGraphDbClient(legacy.socketPath, physicalCollectionName, { connectTimeoutMs: 1_500 });
      await client.init();
      await this.drainStaleDaemon(client, legacy.socketPath);
    }
    // A drained daemon unlinks its own files in cleanup; the direct unlink
    // covers the dead-pid arm and is idempotent belt-and-braces otherwise.
    unlinkDaemonFiles(legacy);
    if (isDebug()) {
      process.stderr.write(`[tea-rags] codegraph: legacy daemon layout in ${dir} removed\n`);
    }
  }

  /**
   * Connect and run the build + capability handshake (bd tea-rags-mcp-ji56r,
   * 39xca.4). A daemon of this build serving every required op, or a
   * pre-fingerprint peer, is returned as is. A daemon of the build on disk that
   * THIS process predates is never drained (bd tea-rags-mcp-1wr7p): a
   * READ-ONLY client is returned when it serves every required op, else
   * `CodegraphClientStaleBuildError`. Otherwise a respawn-capable pool drains,
   * respawns and reconnects up to `maxRestartAttempts`, then throws
   * `CodegraphDaemonBuildSkewError` (its own build still short of an op) or
   * `CodegraphDaemonStaleBuildError`.
   *
   * The bound is small on purpose (bd tea-rags-mcp-ryoqn): each attempt drains a
   * daemon every process on the machine shares, so looping until healthy would
   * thrash them and could livelock two sessions; `CodegraphDaemonExitTimeoutError`
   * from the drain is never retried.
   */
  async connectWithBuildHandshake(
    socketPath: string,
    physicalCollectionName: PhysicalCollectionName,
  ): Promise<DaemonGraphDbClient> {
    // Dynamic so direct/test mode never loads the node:net socket code.
    const { DaemonGraphDbClient, assessDaemonCapability, isClientStale, isDaemonRefusedWithoutRespawn } =
      await import("./client.js");
    const { restart } = this;
    const localFingerprint = restart?.buildFingerprint ?? getBuildFingerprint();
    const readOnDisk = restart?.readOnDiskBuildFingerprint ?? readOnDiskBuildFingerprint;

    // The respawn hook doubles as crash recovery (bd tea-rags-mcp-8l8d3): a
    // daemon killed by a native abort cannot report it, so the client respawns
    // and replays in-flight requests. Pools without the hook reject them instead.
    // The on-disk reader goes along so a refused replay names the stale side
    // the way this handshake does (bd tea-rags-mcp-1wr7p).
    const clientOptions = { onConnectionLost: restart?.respawn, readOnDiskBuildFingerprint: readOnDisk };
    const first = new DaemonGraphDbClient(socketPath, physicalCollectionName, clientOptions);
    try {
      await first.init();
    } catch (err) {
      // Build-keyed sockets (bd tea-rags-mcp-42hno): the connect window still
      // absorbs the spawn→listen race (a worker's first connect races the
      // fire-and-forget `beginRun` spawn), so only a socket that NEVER
      // appeared within it is an OWN-KEY MISS. In a pool that cannot spawn
      // that is the provisioning contract failing, not a wedged daemon —
      // surface the retryable typed error instead of the pre-keying behavior,
      // where a hookless pool silently shared whatever build was running.
      if (!restart?.respawn && !existsSync(socketPath) && err instanceof CodegraphDaemonUnreachableError) {
        throw new CodegraphDaemonBuildUnavailableError({ socketPath, buildKey: getBuildKey() }, err);
      }
      throw err;
    }
    const verdict = assessDaemonCapability(await first.handshake(localFingerprint), localFingerprint);
    // Same build serving every required op, or a legacy pre-fingerprint peer.
    if (!needsDaemonReplacement(verdict)) return first;
    // Asked BEFORE the respawn question: a pool without the hook must name the
    // stale side correctly too when it refuses.
    const onDisk = readOnDisk();
    if (onDisk !== undefined && isClientStale(verdict, onDisk)) {
      return this.settleWithStaleClient(first, verdict, { socketPath, clientFingerprint: localFingerprint, onDisk });
    }

    // No respawn hook (worker-thread pools rebuilt from serializable config):
    // never drain — the daemon is shared machine-wide and this pool could not
    // bring one back. Proceed only against a daemon advertising every required
    // op; refuse one lacking an op, or too old to say (bd tea-rags-mcp-39xca.4).
    const respawn = restart?.respawn;
    if (!respawn) {
      if (isDaemonRefusedWithoutRespawn(verdict)) {
        await first.close();
        throw new CodegraphDaemonBuildSkewError({
          socketPath,
          missingOps: verdict.missingRequiredOps,
          clientFingerprint: localFingerprint,
          daemonFingerprint: verdict.daemonFingerprint,
        });
      }
      if (isDebug()) {
        process.stderr.write(
          `[tea-rags] codegraph daemon ${describeDaemonSkew(verdict, localFingerprint)} — no respawn hook wired, ` +
            `proceeding with the running daemon (it advertises every required op)\n`,
        );
      }
      return first;
    }

    if (isDebug()) {
      process.stderr.write(
        `[tea-rags] codegraph daemon ${describeDaemonSkew(verdict, localFingerprint)} — draining stale daemon ` +
          `and respawning from this build\n`,
      );
    }
    const maxAttempts = Math.max(1, restart?.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS);
    const baseDelayMs = restart?.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    // Post-restart observations only — the pre-restart fingerprint is a
    // mismatch by definition, so including it would make every wedged daemon
    // look like a race.
    const observedDaemonFingerprints: string[] = [];
    let stale = first;
    let lastVerdict = verdict;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Linear backoff with full jitter, so two sessions retrying in lockstep
      // decorrelate instead of trading the daemon back and forth.
      if (attempt > 1) {
        const waitMs = baseDelayMs * (attempt - 1) + Math.random() * baseDelayMs;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      // Re-drain each round: our respawn no-ops while another session's daemon
      // is alive, so without this the next attempt would observe the same
      // foreign build it just saw.
      await this.drainStaleDaemon(stale, socketPath);
      respawn();

      // Reconnect (init retries the connect while the fresh daemon boots) and
      // re-verify build and capabilities.
      const next = new DaemonGraphDbClient(socketPath, physicalCollectionName, clientOptions);
      await next.init();
      const nextVerdict = assessDaemonCapability(await next.handshake(localFingerprint), localFingerprint);
      if (!needsDaemonReplacement(nextVerdict)) return next;
      // The respawn launched the on-disk build and this process predates it:
      // from here the daemon is the up-to-date peer, and another drain would
      // take it down for every session already on it (bd tea-rags-mcp-1wr7p).
      const nextOnDisk = readOnDisk();
      if (nextOnDisk !== undefined && isClientStale(nextVerdict, nextOnDisk)) {
        return this.settleWithStaleClient(next, nextVerdict, {
          socketPath,
          clientFingerprint: localFingerprint,
          onDisk: nextOnDisk,
        });
      }
      if (nextVerdict.daemonFingerprint !== undefined) observedDaemonFingerprints.push(nextVerdict.daemonFingerprint);
      lastVerdict = nextVerdict;
      stale = next;
    }

    await stale.close();
    if (!lastVerdict.buildMismatch) {
      // Our own build came back every time, still without a required op — the
      // respawn hook launches a daemon whose op table is short, not a stale one.
      throw new CodegraphDaemonBuildSkewError({
        socketPath,
        missingOps: lastVerdict.missingRequiredOps,
        clientFingerprint: localFingerprint,
        daemonFingerprint: lastVerdict.daemonFingerprint,
      });
    }
    throw new CodegraphDaemonStaleBuildError(
      socketPath,
      localFingerprint,
      /* v8 ignore next -- buildMismatch implies the daemon reported a fingerprint */
      lastVerdict.daemonFingerprint ?? "unknown",
      observedDaemonFingerprints,
    );
  }

  /**
   * Settle a handshake whose stale side is THIS process (bd tea-rags-mcp-1wr7p):
   * never drain, never respawn. Proceed against the daemon when it serves every
   * op this client requires — the same bar a pool without a respawn hook
   * applies — else close and fail fast with `CodegraphClientStaleBuildError`.
   * Reloading this process is the only remedy; tea-rags does not restart it.
   * `builds.onDisk` is what `isClientStale` matched the daemon's fingerprint
   * against, so it names the daemon's build too.
   *
   * Proceeding is READ-ONLY (`DaemonGraphDbClient#restrictToReads`): the
   * capability check matches op names, so a write whose payload shape moved
   * under an unchanged name would land unnoticed. The graph reads the query
   * tools issue keep working; every write throws the same typed error.
   */
  private async settleWithStaleClient(
    client: DaemonGraphDbClient,
    verdict: DaemonCapabilityVerdict,
    builds: { socketPath: string; clientFingerprint: string; onDisk: string },
  ): Promise<DaemonGraphDbClient> {
    const { isDaemonRefusedWithoutRespawn } = await import("./client.js");
    if (isDaemonRefusedWithoutRespawn(verdict)) {
      await client.close();
      throw new CodegraphClientStaleBuildError({
        socketPath: builds.socketPath,
        clientFingerprint: builds.clientFingerprint,
        daemonFingerprint: builds.onDisk,
        missingOps: verdict.missingRequiredOps,
      });
    }
    client.restrictToReads({ clientFingerprint: builds.clientFingerprint, daemonFingerprint: builds.onDisk });
    if (isDebug()) {
      process.stderr.write(
        `[tea-rags] codegraph daemon ${describeDaemonSkew(verdict, builds.clientFingerprint)} — this process predates ` +
          "the build on disk the daemon runs; proceeding read-only without a restart (it advertises every required " +
          "op). Reconnect the MCP server to load the current build\n",
      );
    }
    return client;
  }

  /**
   * Gracefully retire a stale daemon: request the drain (acked, then the
   * daemon reuses its idle-watcher teardown), close our socket so the daemon's
   * `server.close` is not held open by us, and poll the lifecycle files until
   * the old process is gone. Times out with a typed error — never cold-spawns
   * on top of a daemon that still holds the socket + RW lock.
   */
  async drainStaleDaemon(client: DaemonGraphDbClient, socketPath: string): Promise<void> {
    // The lifecycle files live in the directory owning the socket — the key
    // dir for a keyed daemon, the base dir for the legacy layout the one-time
    // migration drains. NEVER re-keyed: `getDaemonPaths` would nest this
    // build's key UNDER it (bd tea-rags-mcp-42hno).
    const paths = daemonPathsForKeyDir(dirname(socketPath));
    const stalePid = readDaemonPid(paths);
    let refusal: Error | undefined;
    try {
      await client.requestShutdown();
    } catch (err) {
      // The daemon refused because another connection's writes are in flight
      // (bd tea-rags-mcp-zgcmo): settle the drain with the typed refusal
      // instead of waiting out an exit that will never start — the daemon
      // stays up on purpose. Any OTHER shutdown failure (an old daemon that
      // answers the op as unknown, a lost socket) keeps the historical
      // swallow-and-poll path, whose timeout names the wedge.
      if (isDaemonDrainRefusal(err)) refusal = err;
    }
    await client.close();
    if (refusal) {
      throw new CodegraphDaemonDrainRefusedError({ socketPath }, refusal);
    }
    const { restart } = this;
    const exited = await waitForDaemonExit(paths, stalePid, {
      timeoutMs: restart?.exitTimeoutMs,
      pollIntervalMs: restart?.pollIntervalMs,
    });
    if (!exited) {
      throw new CodegraphDaemonExitTimeoutError(socketPath, restart?.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS);
    }
  }
}
