import { connect, type Socket } from "node:net";
import { dirname } from "node:path";

import type {
  AmbiguousCallerSite,
  BulkFileUpsertEntry,
  BulkSymbolUpsertEntry,
  CalleeEdge,
  CallerEdge,
  ChunkGraphSignals,
  CodegraphPass1FileAggregates,
  CodegraphSignalDrift,
  CycleEntry,
  CycleScope,
  EdgeKindCount,
  FileGraphMetrics,
  FileResolveStatsWrite,
  FileScopedSymbolId,
  FileScopedSymbolRef,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  HierarchySnapshot,
  InheritanceEdge,
  PersistedSymbolLineRanges,
  RelPath,
  ResolveRunStatsRow,
  SymbolChunkIdJoinEntry,
  SymbolChunkLocation,
  SymbolDefinition,
  SymbolId,
} from "../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import { isDebug } from "../../../infra/runtime.js";
import {
  CodegraphClientStaleBuildError,
  CodegraphDaemonBuildSkewError,
  CodegraphDaemonUnreachableError,
  CodegraphDaemonUnresponsiveError,
} from "../errors.js";
import { getBuildFingerprint, readOnDiskBuildFingerprint } from "./build-fingerprint.js";
import { DaemonFrameDecoder } from "./frame-decoder.js";
import { getDaemonLogPath } from "./lifecycle.js";
import { DAEMON_OPS, encodeFrame, type DaemonHandshakeResult, type DaemonOp, type DaemonResponse } from "./protocol.js";

/**
 * Does this rejection mean "the daemon on the other end is from a build that
 * has no such op"? The daemon's dispatcher answers an op it does not know with
 * exactly this message (daemon/server.ts) — the deliberate fall-through kept
 * for protocol evolution — so the match is on that one sentence and nothing
 * else. Anything wider would swallow real DuckDB failures.
 */
function isUnknownDaemonOp(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith("unknown daemon op:");
}

const LEGACY_TOLERATED_OP_LIST = [
  "getFileMetricsBulk",
  "getSymbolLineRangesBulk",
  "diffSymbolSignals",
  "refreshSymbolSignalsPrev",
  "ping",
] as const satisfies readonly DaemonOp[];

type LegacyToleratedDaemonOp = (typeof LEGACY_TOLERATED_OP_LIST)[number];

/**
 * The ops a daemon from an older build may lack WITHOUT this client refusing it
 * (bd tea-rags-mcp-39xca.4). Every other op in `DAEMON_OPS` is REQUIRED: a pool
 * refuses — or, with a respawn hook, replaces — a daemon whose handshake does
 * not advertise it, and a call the daemon still answers as unknown throws
 * `CodegraphDaemonBuildSkewError`.
 *
 * An op belongs here only if its fallback is CORRECT, or at worst the behaviour
 * before the op existed:
 * - `getFileMetricsBulk` — the three per-file reads it replaced; slow, same map.
 * - `getSymbolLineRangesBulk` — no rows known, so every chunk the heal would
 *   place is left unsettled: no write, never a guessed owner (bd
 *   tea-rags-mcp-39xca.2).
 * - `diffSymbolSignals` — "nothing moved", the pre-a2ddb behaviour. "Everything
 *   moved" would be worse: such a daemon has no `cg_symbol_signals_prev`, so the
 *   heal would rewrite the corpus on every run and never converge.
 * - `refreshSymbolSignalsPrev` — that daemon has no baseline table to refresh.
 * - `ping` — the liveness probe (bd tea-rags-mcp-f924y). An older daemon's
 *   "unknown daemon op" answer is itself the proof of life the probe asks for.
 *
 * An op whose fallback is wrong data stays required — weno4's
 * `listAllPass1Aggregates` degraded a live repair to a batch-scoped registry.
 */
export const LEGACY_TOLERATED_OPS: ReadonlySet<DaemonOp> = new Set<DaemonOp>(LEGACY_TOLERATED_OP_LIST);

/** Every op this client may call that an older daemon is NOT allowed to lack. */
export const REQUIRED_DAEMON_OPS: readonly DaemonOp[] = DAEMON_OPS.filter((op) => !LEGACY_TOLERATED_OPS.has(op));

/** What one handshake says about working against that daemon (bd tea-rags-mcp-39xca.4). */
export interface DaemonCapabilityVerdict {
  /** The daemon's build fingerprint; undefined for a pre-fingerprint daemon. */
  readonly daemonFingerprint?: string;
  /** Both peers reported a fingerprint and they differ. */
  readonly buildMismatch: boolean;
  /** REQUIRED ops the daemon did not advertise; empty when it advertised nothing. */
  readonly missingRequiredOps: readonly DaemonOp[];
  /** The daemon reported a fingerprint but no capability list — built before advertisement. */
  readonly predatesCapabilityList: boolean;
}

/**
 * Judge a handshake result against this client's build. A pre-fingerprint
 * daemon (null result) yields an all-clear verdict — the long-standing "legacy
 * peer, proceed" rule — because it reports nothing to compare.
 */
export function assessDaemonCapability(
  handshake: DaemonHandshakeResult | null,
  clientFingerprint: string,
): DaemonCapabilityVerdict {
  const daemonFingerprint = handshake?.buildFingerprint;
  const supportedOps = handshake?.supportedOps;
  return {
    daemonFingerprint,
    buildMismatch: daemonFingerprint !== undefined && daemonFingerprint !== clientFingerprint,
    missingRequiredOps:
      supportedOps === undefined ? [] : REQUIRED_DAEMON_OPS.filter((op) => !supportedOps.includes(op)),
    predatesCapabilityList: daemonFingerprint !== undefined && supportedOps === undefined,
  };
}

/**
 * The bar a client that cannot replace the daemon holds it to (bd
 * tea-rags-mcp-39xca.4): it refuses a daemon lacking a required op, or one from
 * another build too old to say what it serves. A daemon from another build that
 * advertises every required op is tolerated — proceeding against either refused
 * shape turns missing ops into missing data. The pool's hookless path and its
 * stale-client settle (bd tea-rags-mcp-1wr7p) and the replay path (bd
 * tea-rags-mcp-f924y) all apply this one rule.
 */
export function isDaemonRefusedWithoutRespawn(verdict: DaemonCapabilityVerdict): boolean {
  return verdict.missingRequiredOps.length > 0 || (verdict.predatesCapabilityList && verdict.buildMismatch);
}

/**
 * The CLIENT is the stale side of a build mismatch (bd tea-rags-mcp-1wr7p): the
 * daemon runs the build on disk NOW, which this process's loaded code predates.
 * Draining cannot converge — every respawn launches that same on-disk build — so
 * the daemon is never drained for it, and a refusal names this process, not the
 * daemon. Callers ask only with a READABLE on-disk fingerprint: an unreadable
 * one proves nothing.
 */
export function isClientStale(verdict: DaemonCapabilityVerdict, onDiskFingerprint: string): boolean {
  return verdict.buildMismatch && verdict.daemonFingerprint === onDiskFingerprint;
}

/** Tolerated ops already reported missing in this process — the warning is once per op. */
const warnedLegacyDaemonOps = new Set<LegacyToleratedDaemonOp>();

/**
 * Say — once per op per process, and outside DEBUG — that a tolerated op fell
 * back. The fallback is accepted, never silent: a debug-only line is how a
 * degraded heal went unnoticed until someone read DuckDB by hand.
 */
function warnLegacyDaemonOpOnce(op: LegacyToleratedDaemonOp): void {
  if (warnedLegacyDaemonOps.has(op)) return;
  warnedLegacyDaemonOps.add(op);
  console.error(
    `[tea-rags] codegraph daemon is from an older build without "${op}" — using its legacy ` +
      "fallback until the daemon is restarted from the current build",
  );
}

/**
 * Thrown when a daemon-internal op is invoked on the daemon client. In daemon
 * mode the `DaemonGraphDbClient` is the SOLE accessor of the DuckDB file, so it
 * proxies the ENTIRE `GraphDbClient` surface — every write AND every read — over
 * the socket. The lone exception is `streamAdjacency`: the heavy graph analysis
 * runs daemon-side via `computeAndPersistCyclesAndSignals`, so the adjacency
 * stream must NOT cross IPC and still throws this error if called on the client.
 */
export class UnsupportedDaemonReadError extends Error {
  constructor(op: string) {
    super(`DaemonGraphDbClient is write-only; read op "${op}" must use the in-process RO handle`);
    this.name = "UnsupportedDaemonReadError";
  }
}

/**
 * `GraphDbClient` that proxies the entire codegraph surface — every mutation
 * and every read — to the codegraph daemon over a unix socket using
 * newline-JSON framing. Each call gets a monotonic id; responses are matched
 * back by id through the `pending` map. Only `streamAdjacency` is NOT proxied:
 * it stays daemon-internal (consumed by the daemon-side
 * `computeAndPersistCyclesAndSignals`) and throws `UnsupportedDaemonReadError`.
 */
/** Tunable connect-readiness window for the spawn→connect race. */
export interface DaemonClientOptions {
  /**
   * Upper bound on how long `init()` keeps retrying the unix-socket connect
   * before rejecting. Default ~5s — generous enough for a detached daemon to
   * finish `server.listen` after a cold spawn, bounded so a permanently-absent
   * daemon surfaces loudly instead of hanging.
   */
  connectTimeoutMs?: number;
  /** Delay between connect attempts when the socket is not yet accepting. */
  retryDelayMs?: number;
  /**
   * Called when the daemon drops the connection while requests are still in
   * flight, BEFORE this client tries to reconnect — the owner's chance to bring
   * a replacement daemon up (bd tea-rags-mcp-8l8d3).
   *
   * Wiring it is what turns a dead daemon from "the whole indexing run fails"
   * into "one request was retried". The pool points it at the same respawn hook
   * the stale-build restart path uses. Leave it unset and the client behaves
   * exactly as it did before: every pending call rejects.
   *
   * A daemon killed by a native DuckDB `FatalException` is the case this
   * exists for. That is a SIGABRT out of C++ — `CodegraphDaemonServer#handle`
   * cannot turn it into an error response, because it never becomes a JS throw.
   */
  onConnectionLost?: () => void | Promise<void>;
  /**
   * How long the daemon may stay completely silent while calls are pending
   * before every pending call fails with `CodegraphDaemonUnresponsiveError`
   * (bd tea-rags-mcp-f924y). Not an op timeout: a live daemon answers liveness
   * probes while a long op runs, so only a wedged daemon — or a connection that
   * died without closing — reaches it.
   */
  livenessTimeoutMs?: number;
  /** How long a silence with calls pending lasts before the client probes the daemon. */
  livenessProbeIntervalMs?: number;
  /**
   * Reader of the build on disk NOW — what a respawned daemon reports. The
   * replay path asks it which side a refusal blames (bd tea-rags-mcp-1wr7p).
   * Defaults to `readOnDiskBuildFingerprint`; the pool passes its own override.
   */
  readOnDiskBuildFingerprint?: () => string | undefined;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 75;

/**
 * Five minutes of total silence. A live daemon still pauses its event loop for
 * synchronous work — Tarjan and PageRank over the whole method graph, parsing a
 * large bulk-write frame — and answers no probe meanwhile; those pauses run to
 * seconds, so the bound clears them with a wide margin and still turns the
 * observed "waited 12+ minutes, then forever" into a failure.
 */
const DEFAULT_LIVENESS_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LIVENESS_PROBE_INTERVAL_MS = 15_000;

/**
 * One request waiting on the daemon. The encoded `frame` is retained so a
 * request whose daemon died under it can be re-sent verbatim to its
 * replacement; `retried` bounds that to one attempt (bd tea-rags-mcp-8l8d3).
 */
interface PendingDaemonCall {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly frame: string;
  retried: boolean;
}

/** ENOENT (socket file not created yet) / ECONNREFUSED (server not listening yet). */
function isRetryableConnectError(err: NodeJS.ErrnoException): boolean {
  return err.code === "ENOENT" || err.code === "ECONNREFUSED";
}

export class DaemonGraphDbClient implements GraphDbClient {
  private sock?: Socket;
  /** Per-connection frame assembly; replaced on each successful connect. */
  private frames = new DaemonFrameDecoder();
  private nextId = 1;
  private readonly pending = new Map<number, PendingDaemonCall>();
  private readonly connectTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly onConnectionLost?: () => void | Promise<void>;
  /** Set by `close()`, so a socket teardown WE asked for never respawns a daemon. */
  private closedByCaller = false;
  /** One recovery at a time — every pending call shares the reconnect. */
  private recovering?: Promise<void>;
  /**
   * The build this client last handshook as. A replacement daemon is
   * handshaken under the same identity before anything is replayed onto it
   * (bd tea-rags-mcp-f924y).
   */
  private handshakeFingerprint?: string;
  private readonly livenessTimeoutMs: number;
  private readonly livenessProbeIntervalMs: number;
  private readonly readOnDisk: () => string | undefined;
  /** When the daemon was last heard from — any bytes on the socket, or the connect itself. */
  private lastHeardAt = 0;
  /** Runs only while calls are pending — see `watchLiveness`. */
  private livenessTimer?: NodeJS.Timeout;

  constructor(
    private readonly socketPath: string,
    private readonly collection: PhysicalCollectionName,
    opts?: DaemonClientOptions,
  ) {
    this.connectTimeoutMs = opts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.onConnectionLost = opts?.onConnectionLost;
    this.livenessTimeoutMs = opts?.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
    this.livenessProbeIntervalMs = opts?.livenessProbeIntervalMs ?? DEFAULT_LIVENESS_PROBE_INTERVAL_MS;
    this.readOnDisk = opts?.readOnDiskBuildFingerprint ?? readOnDiskBuildFingerprint;
  }

  /**
   * Connect to the daemon socket, retrying on ENOENT/ECONNREFUSED with a small
   * backoff until the socket accepts or `connectTimeoutMs` elapses. This absorbs
   * the detached-spawn race: the factory spawns the daemon process, then the
   * very next `acquireWrite` calls `init()` before the daemon has reached
   * `server.listen`. Without the retry that connect throws ENOENT and the whole
   * write fails. A non-retryable error (or timeout) rejects with a clear cause.
   */
  async init(): Promise<void> {
    const deadline = Date.now() + this.connectTimeoutMs;
    for (;;) {
      try {
        await this.connectOnce();
        return;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        const timedOut = Date.now() + this.retryDelayMs >= deadline;
        if (!isRetryableConnectError(e) || timedOut) {
          // The spawner hands the daemon's stdout + stderr to a log next to the
          // socket. Without naming it here the caller sees a bare ENOENT and has
          // no way to learn that the daemon crashed, let alone why.
          throw new CodegraphDaemonUnreachableError(
            {
              socketPath: this.socketPath,
              connectTimeoutMs: this.connectTimeoutMs,
              detail: e.code ?? e.message,
              logPath: getDaemonLogPath(dirname(this.socketPath)),
            },
            err instanceof Error ? err : undefined,
          );
        }
        await new Promise<void>((r) => setTimeout(r, this.retryDelayMs));
      }
    }
  }

  /** Single connect attempt; resolves on `connect`, rejects on `error`. */
  private async connectOnce(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = connect(this.socketPath);
      const onError = (err: Error): void => {
        sock.destroy();
        reject(err);
      };
      sock.once("connect", () => {
        sock.removeListener("error", onError);
        this.sock = sock;
        this.lastHeardAt = Date.now();
        // A retried connect must not inherit a half-assembled frame from the
        // attempt that failed.
        this.frames = new DaemonFrameDecoder();
        // The daemon idle-exits after IDLE_SHUTDOWN_MS and the pool caches this
        // client for the life of the process, so outliving the daemon is the
        // normal case. Whichever way the socket goes down, every call waiting
        // on it has to be told: nothing else settles those promises, and `call`
        // sets no timeout, so a missed teardown hangs the caller indefinitely
        // (a graph query was seen waiting 30 minutes at 0% CPU).
        sock.on("error", (err: Error) => {
          void this.handleConnectionLoss(`daemon connection failed: ${err.message}`);
        });
        sock.on("close", () => {
          void this.handleConnectionLoss("daemon closed the connection before the response arrived");
        });
        sock.on("data", (d) => {
          this.onData(d);
        });
        resolve();
      });
      sock.once("error", onError);
    });
  }

  private onData(chunk: Buffer): void {
    this.lastHeardAt = Date.now();
    for (const f of this.frames.push(chunk)) {
      const res = JSON.parse(f) as DaemonResponse;
      const p = this.pending.get(res.id);
      if (!p) continue;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(Object.assign(new Error(res.error.message), { name: res.error.name }));
    }
  }

  /**
   * Send one request and await its response. A daemon that answers the op as
   * unknown is from an older build: that rejection becomes a typed
   * `CodegraphDaemonBuildSkewError` naming the op (bd tea-rags-mcp-39xca.4), so
   * it surfaces as build skew rather than a generic failure. The few ops allowed
   * to degrade go through `callTolerated`, which catches exactly that type.
   */
  private async call(
    op: DaemonOp,
    params: Record<string, unknown>,
    options: { replayable?: boolean } = {},
  ): Promise<unknown> {
    const { sock } = this;
    if (!sock) throw new Error("DaemonGraphDbClient.call before init() / after close()");
    const id = this.nextId++;
    const frame = encodeFrame({ id, op, params: { collection: this.collection, ...params } });
    // A non-replayable call starts out as if already retried: a connection loss
    // settles it rather than re-sending it.
    const retried = options.replayable === false;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, frame, retried });
        this.watchLiveness();
        sock.write(frame);
      });
    } catch (err) {
      if (!isUnknownDaemonOp(err)) throw err;
      throw new CodegraphDaemonBuildSkewError({ socketPath: this.socketPath, missingOps: [op] }, err);
    }
  }

  /**
   * `call` for an op in `LEGACY_TOLERATED_OPS`. A daemon from an older build that
   * answers it as unknown gets `fallback()` instead of a failure, plus one
   * non-debug warning per op per process — the degrade is accepted, never
   * silent. Any other error, a real daemon failure included, propagates.
   */
  private async callTolerated<T>(
    op: LegacyToleratedDaemonOp,
    params: Record<string, unknown>,
    decode: (result: unknown) => T,
    fallback: () => T | Promise<T>,
  ): Promise<T> {
    let result: unknown;
    try {
      result = await this.call(op, params);
    } catch (err) {
      if (!(err instanceof CodegraphDaemonBuildSkewError)) throw err;
      warnLegacyDaemonOpOnce(op);
      return fallback();
    }
    return decode(result);
  }

  async close(): Promise<void> {
    this.closedByCaller = true;
    this.stopLivenessWatch();
    this.sock?.end();
    this.abandon("closed before response arrived");
  }

  /**
   * Whether this client still holds a live socket. The pool reads it before
   * handing a cached client back: a client whose daemon exited is spent, and
   * reusing it would only produce "call after close" for the rest of the
   * process's life.
   */
  isConnected(): boolean {
    return this.sock !== undefined;
  }

  /**
   * Watch the daemon's liveness while calls are pending (bd tea-rags-mcp-f924y).
   * `call` sets no op timeout on purpose — cycles/PageRank legitimately run for
   * minutes — so this is the only bound on a daemon that is alive but wedged, or
   * a connection that died without a close. The silence clock starts with the
   * first pending call; `checkLiveness` owns every tick.
   */
  private watchLiveness(): void {
    if (this.livenessTimer) return;
    this.lastHeardAt = Date.now();
    this.livenessTimer = setInterval(() => {
      this.checkLiveness();
    }, this.livenessProbeIntervalMs);
    this.livenessTimer.unref();
  }

  private stopLivenessWatch(): void {
    clearInterval(this.livenessTimer);
    this.livenessTimer = undefined;
  }

  /**
   * One tick: nothing pending → stop; silent past the bound → fail every pending
   * call with `CodegraphDaemonUnresponsiveError` and drop the socket; silent for
   * a probe interval → ping. The probe is fire-and-forget, with no pending entry
   * of its own, so it is never replayed and never holds up a recovery; its
   * answer — like any bytes, including an older daemon's "unknown op" — only
   * refreshes `lastHeardAt`. No probe goes out while a recovery has no socket.
   */
  private checkLiveness(): void {
    if (this.pending.size === 0) {
      this.stopLivenessWatch();
      return;
    }
    const silentForMs = Date.now() - this.lastHeardAt;
    if (silentForMs >= this.livenessTimeoutMs) {
      this.stopLivenessWatch();
      const unresponsive = new CodegraphDaemonUnresponsiveError({
        socketPath: this.socketPath,
        silentForMs,
        pendingCalls: this.pending.size,
      });
      const { sock } = this;
      this.sock = undefined;
      // Settled before the socket goes, so its `close` finds nothing to recover.
      this.settlePending(
        () => true,
        () => unresponsive,
      );
      sock?.destroy();
      return;
    }
    if (silentForMs >= this.livenessProbeIntervalMs) {
      this.sock?.write(encodeFrame({ id: this.nextId++, op: "ping", params: { collection: this.collection } }));
    }
  }

  /**
   * The socket went down. Recover the requests riding on it if that is possible
   * — otherwise settle them, which is what this class always did
   * (bd tea-rags-mcp-8l8d3).
   *
   * Recovery is attempted only when there is something to recover (a pending
   * request that has not already been retried), the caller did not ask for the
   * teardown, and an `onConnectionLost` hook is wired to bring a replacement
   * daemon up. Everything else — an idle-exited daemon with no in-flight work,
   * an explicit `close()`, a pool that cannot cold-spawn — takes the original
   * path and rejects.
   *
   * The whole recovery is ONE shared promise: a bulk write and a metrics read
   * that were both in flight when the daemon aborted must not respawn it twice.
   */
  private async handleConnectionLoss(reason: string): Promise<void> {
    this.sock = undefined;
    if (this.pending.size === 0) return;
    if (this.closedByCaller || !this.onConnectionLost) {
      this.abandon(reason);
      return;
    }
    // A call that was already re-sent once — or was never replayable, like the
    // recovery handshake itself — is settled now. Left pending, nothing would
    // ever settle it: the replay below skips it (bd tea-rags-mcp-f924y).
    this.settlePending(
      (p) => p.retried,
      () => new Error(`DaemonGraphDbClient ${reason}`),
    );
    if (this.pending.size === 0) return;
    this.recovering ??= this.reconnectAndReplay(reason).finally(() => {
      this.recovering = undefined;
    });
    await this.recovering;
  }

  /**
   * Bring a daemon back, reconnect, and re-send every pending request.
   *
   * Re-sending is safe because every op this client proxies is idempotent by
   * construction: file and symbol writes reconcile a scope against the rows
   * they carry, checkpoints and cycle/PageRank rebuilds are recomputes, run
   * stats replace their language's rows, and reads mutate nothing. A request
   * that had ALREADY landed daemon-side before the abort therefore costs a
   * repeat, never a corruption.
   *
   * Each request is replayed at most once (`retried`), so a daemon that dies on
   * every attempt surfaces the failure instead of looping.
   *
   * The replacement is handshaken first (bd tea-rags-mcp-f924y). A daemon that
   * died because another session's build handshake drained it comes back as
   * THAT session's build, and a replay onto it unverified sends ops it may not
   * know or read with a payload shape that moved. It is held to the bar a client
   * that cannot replace the daemon applies (`isDaemonRefusedWithoutRespawn`):
   * refused, every pending request fails with the error naming the stale side
   * (`describeRefusal`) and nothing is replayed. Draining it is not this client's call — that
   * decision belongs to the pool's handshake, so the client also lets go of
   * the connection: the pool runs that handshake only for a client that is no
   * longer connected.
   */
  private async reconnectAndReplay(reason: string): Promise<void> {
    const fingerprint = this.handshakeFingerprint ?? getBuildFingerprint();
    let verdict: DaemonCapabilityVerdict;
    try {
      await this.onConnectionLost?.();
      await this.init();
      const handshake = (await this.call(
        "handshake",
        { buildFingerprint: fingerprint },
        { replayable: false },
      )) as DaemonHandshakeResult | null;
      verdict = assessDaemonCapability(handshake, fingerprint);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      this.abandon(`${reason} and could not be recovered: ${cause}`);
      return;
    }
    if (isDaemonRefusedWithoutRespawn(verdict)) {
      const refusal = this.describeRefusal(verdict, fingerprint);
      // Let go of the refused daemon before telling anyone. Kept connected,
      // this client would read as healthy, the pool would keep handing it back
      // and its build handshake — the one place allowed to drain or respawn —
      // would never run again; the open connection would also hold the refused
      // daemon up against its idle exit.
      this.releaseSocket();
      this.settlePending(
        () => true,
        () => refusal,
      );
      return;
    }
    const { sock } = this;
    /* v8 ignore next 4 -- init() either sets the socket or throws; a resolved
       init with no socket is unreachable, but rejecting beats writing to
       undefined if that ever changes. */
    if (!sock) {
      this.abandon(reason);
      return;
    }
    if (isDebug()) {
      process.stderr.write(
        `[tea-rags] codegraph daemon went away (${reason}) — reconnected, replaying ${this.pending.size} request(s)\n`,
      );
    }
    for (const p of this.pending.values()) {
      if (p.retried) continue;
      p.retried = true;
      sock.write(p.frame);
    }
  }

  /**
   * The error a refused replay settles with, naming the stale side the way the
   * pool's handshake does (bd tea-rags-mcp-1wr7p): when the replacement runs the
   * build on disk that this process predates, the fault is THIS process —
   * `CodegraphClientStaleBuildError`, remedied by reloading it. Otherwise the
   * daemon is the one behind: `CodegraphDaemonBuildSkewError`.
   */
  private describeRefusal(verdict: DaemonCapabilityVerdict, clientFingerprint: string): Error {
    const onDisk = verdict.buildMismatch ? this.readOnDisk() : undefined;
    if (onDisk !== undefined && isClientStale(verdict, onDisk)) {
      return new CodegraphClientStaleBuildError({
        socketPath: this.socketPath,
        clientFingerprint,
        daemonFingerprint: onDisk,
        missingOps: verdict.missingRequiredOps,
      });
    }
    return new CodegraphDaemonBuildSkewError({
      socketPath: this.socketPath,
      missingOps: verdict.missingRequiredOps,
      clientFingerprint,
      daemonFingerprint: verdict.daemonFingerprint,
    });
  }

  /**
   * Forget the socket and close our end of it, so `isConnected()` turns false
   * and the daemon sees the connection go. Its `close` event still reaches
   * `handleConnectionLoss`, which finds nothing left to recover once the caller
   * has settled `pending`.
   */
  private releaseSocket(): void {
    const { sock } = this;
    this.sock = undefined;
    sock?.end();
  }

  /**
   * Drop the socket and settle everything waiting on it. Idempotent — the
   * socket's own `close` event fires after an explicit `close()` too, and by
   * then `pending` is already empty, so the second pass is a no-op.
   */
  private abandon(reason: string): void {
    this.sock = undefined;
    this.settlePending(
      () => true,
      () => new Error(`DaemonGraphDbClient ${reason}`),
    );
  }

  /** Reject — and forget — every pending call `which` selects. */
  private settlePending(which: (p: PendingDaemonCall) => boolean, error: () => Error): void {
    for (const [id, p] of [...this.pending.entries()]) {
      if (!which(p)) continue;
      this.pending.delete(id);
      p.reject(error());
    }
  }

  // ── build-version handshake (bd tea-rags-mcp-ji56r) ──

  /**
   * Exchange build fingerprints with the daemon. Sends the CLIENT's
   * fingerprint; resolves the daemon's (a legacy daemon returns null — no
   * fingerprint, treated by the pool as "proceed, no restart"). On a match or
   * legacy peer the daemon also opens + migrates + hydrates the collection.
   */
  async handshake(buildFingerprint?: string): Promise<DaemonHandshakeResult | null> {
    if (buildFingerprint !== undefined) this.handshakeFingerprint = buildFingerprint;
    // `undefined` vanishes in JSON serialisation — a legacy-shaped request.
    return (await this.call("handshake", { buildFingerprint })) as DaemonHandshakeResult | null;
  }

  /**
   * Ask the daemon to drain in-flight ops and exit gracefully (release the RW
   * DuckDB lock + remove its lifecycle files). The daemon ACKS first, then
   * tears down via its idle-watcher drain/exit path — the caller must close
   * its socket and poll the lifecycle files for the actual exit.
   */
  async requestShutdown(): Promise<void> {
    await this.call("shutdown", {});
  }

  // ── writes (proxied over the socket) ──

  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    await this.call("upsertFile", { node, edges });
  }

  async removeFile(relPath: RelPath): Promise<void> {
    await this.call("removeFile", { relPath });
  }

  async removeSymbolsForFile(relPath: RelPath): Promise<void> {
    await this.call("removeSymbolsForFile", { relPath });
  }

  async upsertSymbols(relPath: RelPath, definitions: SymbolDefinition[]): Promise<void> {
    await this.call("upsertSymbols", { relPath, definitions });
  }

  async upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void> {
    await this.call("upsertSymbolsBulk", { entries });
  }

  async upsertFilesBulk(entries: readonly BulkFileUpsertEntry[]): Promise<void> {
    await this.call("upsertFilesBulk", { entries });
  }

  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    await this.call("updateSymbolChunkIds", { relPath, chunkIds: [...chunkIds.entries()] });
  }

  async updateSymbolChunkIdsBulk(entries: readonly SymbolChunkIdJoinEntry[]): Promise<void> {
    // Each file's join travels as Map entries — a Map does not survive JSON.
    await this.call("updateSymbolChunkIdsBulk", {
      entries: entries.map((e) => ({ relPath: e.relPath, chunkIds: [...e.chunkIds.entries()] })),
    });
  }

  async findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    return (await this.call("findSymbolChunk", { symbolId })) as SymbolChunkLocation | null;
  }

  async replaceCycles(scope: CycleScope, sccs: readonly (readonly string[])[]): Promise<void> {
    await this.call("replaceCycles", { scope, sccs });
  }

  async replacePageRanks(ranks: ReadonlyMap<string, number>): Promise<void> {
    // A Map cannot JSON-serialise — send entries; the server rebuilds the Map.
    await this.call("replacePageRanks", { ranks: [...ranks.entries()] });
  }

  async checkpoint(): Promise<void> {
    await this.call("checkpoint", {});
  }

  async rebuildEdgeFileTargetIndex(): Promise<void> {
    await this.call("rebuildEdgeFileTargetIndex", {});
  }

  async recordRunStats(rows: ResolveRunStatsRow[]): Promise<void> {
    await this.call("recordRunStats", { rows });
  }

  async recordFileResolveStats(write: FileResolveStatsWrite): Promise<void> {
    await this.call("recordFileResolveStats", { write });
  }

  /**
   * Delete the superseded version's DuckDB file after the Qdrant alias swap.
   * Concrete daemon method (NOT on the `GraphDbClient` interface) — driven by
   * the force-reindex path once the alias flips readers onto `newVersion`.
   */
  async finalizeReindex(oldVersion: string, newVersion: string): Promise<void> {
    await this.call("finalizeReindex", { oldVersion, newVersion });
  }

  /**
   * Concrete daemon method (NOT yet on the `GraphDbClient` interface — added in
   * Task 7). Runs SCC + PageRank daemon-side so the heavy graph build stays in
   * the single daemon process.
   */
  async computeAndPersistCyclesAndSignals(): Promise<void> {
    await this.call("computeAndPersistCyclesAndSignals", {});
  }

  /**
   * Record the current signals as the baseline for the next run's drift diff
   * (bd tea-rags-mcp-a2ddb). A tolerated legacy op: a daemon that predates it
   * has not run migration 023 either, so there is no baseline to refresh.
   */
  async refreshSymbolSignalsPrev(): Promise<void> {
    await this.callTolerated(
      "refreshSymbolSignalsPrev",
      {},
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Symbols and files whose derived signals moved since the baseline
   * (bd tea-rags-mcp-a2ddb). A tolerated legacy op: a daemon that predates it
   * answers "nothing moved" — why that and not "everything moved" is recorded
   * on `LEGACY_TOLERATED_OPS`.
   */
  async diffSymbolSignals(): Promise<CodegraphSignalDrift> {
    return this.callTolerated(
      "diffSymbolSignals",
      {},
      (result) => result as CodegraphSignalDrift,
      () => ({ symbols: [], files: [] }),
    );
  }

  // ── reads (proxied over the socket) ──
  // Every read routes through the daemon's own RW connection: DuckDB's RW lock
  // is process-exclusive, so a cross-process READ_ONLY attach throws
  // "Conflicting lock is held" while the daemon holds RW. The daemon being the
  // sole file opener means zero conflict. `streamAdjacency` is the ONE read
  // that stays daemon-internal (below) — its heavy adjacency stream must not
  // cross IPC and is consumed daemon-side by computeAndPersistCyclesAndSignals.

  async getFanIn(relPath: RelPath): Promise<number> {
    return (await this.call("getFanIn", { relPath })) as number;
  }

  async getFanInP95(): Promise<number> {
    return (await this.call("getFanInP95", {})) as number;
  }

  async getFanOut(relPath: RelPath): Promise<number> {
    return (await this.call("getFanOut", { relPath })) as number;
  }

  async getCallers(symbolId: SymbolId): Promise<CallerEdge[]> {
    return (await this.call("getCallers", { symbolId })) as CallerEdge[];
  }

  async getCallees(symbolId: SymbolId): Promise<CalleeEdge[]> {
    return (await this.call("getCallees", { symbolId })) as CalleeEdge[];
  }

  async getAmbiguousCallersByMember(member: string, limit?: number): Promise<AmbiguousCallerSite[]> {
    return (await this.call("getAmbiguousCallersByMember", { member, limit })) as AmbiguousCallerSite[];
  }

  async getCalleeEdges(symbolIds: SymbolId[]): Promise<Map<SymbolId, SymbolId[]>> {
    // The server serialises the `Map<SymbolId, SymbolId[]>` as `[key, value][]`
    // entries (a Map cannot JSON-serialise) — rebuild the Map here.
    const entries = (await this.call("getCalleeEdges", { symbolIds })) as [SymbolId, SymbolId[]][];
    return new Map(entries);
  }

  async getCalleeEdgesScoped(refs: FileScopedSymbolRef[]): Promise<Map<FileScopedSymbolId, FileScopedSymbolRef[]>> {
    // Own op rather than a widened `getCalleeEdges` payload (bd
    // tea-rags-mcp-oxnvl): a daemon from an older build stays running across a
    // rebuild, and reusing the name would hand it a shape it cannot read.
    // Serialised as `[key, value][]` entries — a Map cannot JSON-serialise.
    const entries = (await this.call("getCalleeEdgesScoped", { refs })) as [
      FileScopedSymbolId,
      FileScopedSymbolRef[],
    ][];
    return new Map(entries);
  }

  async getSymbolRelPaths(symbolIds: SymbolId[]): Promise<Map<SymbolId, RelPath[]>> {
    const entries = (await this.call("getSymbolRelPaths", { symbolIds })) as [SymbolId, RelPath[]][];
    return new Map(entries);
  }

  async getCalledByCount(symbolId: SymbolId): Promise<number> {
    return (await this.call("getCalledByCount", { symbolId })) as number;
  }

  async getCallSiteCount(symbolId: SymbolId): Promise<number> {
    return (await this.call("getCallSiteCount", { symbolId })) as number;
  }

  async getChunkSignalsBulk(): Promise<Map<SymbolId, ChunkGraphSignals>> {
    // Server serialises the Map as `[key, value][]` entries — rebuild here
    // (same pattern as getCalleeEdges / listAdjacency).
    const entries = (await this.call("getChunkSignalsBulk", {})) as [SymbolId, ChunkGraphSignals][];
    return new Map(entries);
  }

  async getSymbolLineRangesBulk(relPaths: readonly RelPath[]): Promise<Map<RelPath, PersistedSymbolLineRanges>> {
    // Server serialises the Map as `[key, value][]` entries — rebuild here. A
    // tolerated legacy op: a daemon that predates it answers "no rows known",
    // which leaves every chunk the heal would place unsettled — no write, never
    // a guessed owner (bd tea-rags-mcp-39xca.2).
    return this.callTolerated(
      "getSymbolLineRangesBulk",
      { relPaths },
      (result) => new Map(result as [RelPath, PersistedSymbolLineRanges][]),
      () => new Map<RelPath, PersistedSymbolLineRanges>(),
    );
  }

  async hasData(): Promise<boolean> {
    return (await this.call("hasData", {})) as boolean;
  }

  async getRunStats(): Promise<ResolveRunStatsRow[]> {
    return (await this.call("getRunStats", {})) as ResolveRunStatsRow[];
  }

  async getEdgeKindDistribution(): Promise<EdgeKindCount[]> {
    return (await this.call("getEdgeKindDistribution", {})) as EdgeKindCount[];
  }

  async listAllSymbols(): Promise<SymbolDefinition[]> {
    return (await this.call("listAllSymbols", {})) as SymbolDefinition[];
  }

  async listAllPass1Aggregates(): Promise<CodegraphPass1FileAggregates[]> {
    return (await this.call("listAllPass1Aggregates", {})) as CodegraphPass1FileAggregates[];
  }

  async listFileContentHashes(): Promise<{ relPath: RelPath; contentHash: string | null }[]> {
    return (await this.call("listFileContentHashes", {})) as { relPath: RelPath; contentHash: string | null }[];
  }

  async getTransitiveImpact(relPath: RelPath, maxDepth?: number): Promise<number> {
    return (await this.call("getTransitiveImpact", { relPath, maxDepth })) as number;
  }

  async getFileMetricsBulk(relPaths: readonly RelPath[], maxDepth?: number): Promise<Map<RelPath, FileGraphMetrics>> {
    // Server serialises the Map as `[key, value][]` entries — rebuild here
    // (same pattern as getChunkSignalsBulk / getCalleeEdges). The caller
    // bounds `relPaths`: this array IS the request frame, and the daemon's
    // reply frame carries one entry per root it knows about.
    return this.callTolerated(
      "getFileMetricsBulk",
      { relPaths, maxDepth },
      (result) => new Map(result as [RelPath, FileGraphMetrics][]),
      async () => this.fileMetricsPerFile(relPaths, maxDepth),
    );
  }

  /**
   * Legacy-daemon fallback for `getFileMetricsBulk`, a tolerated legacy op. A
   * pool tolerates a daemon from another build while it advertises every
   * REQUIRED op (pool.ts), so a client from this build can meet a daemon that
   * never heard of the setwise op. Rather than failing the whole finalize pass,
   * walk the same roots through the three per-file reads the op replaces and
   * assemble the identical map: absent means all-zero, so a root with nothing
   * in either direction is left out.
   *
   * Deliberately serialized and deliberately slow — this is the pre-setwise
   * cost, on a path that only has to stay CORRECT until the daemon is
   * restarted from the matching build.
   */
  private async fileMetricsPerFile(
    relPaths: readonly RelPath[],
    maxDepth?: number,
  ): Promise<Map<RelPath, FileGraphMetrics>> {
    const out = new Map<RelPath, FileGraphMetrics>();
    for (const relPath of relPaths) {
      const fanIn = await this.getFanIn(relPath);
      const fanOut = await this.getFanOut(relPath);
      const transitiveImpact = await this.getTransitiveImpact(relPath, maxDepth);
      if (fanIn !== 0 || fanOut !== 0 || transitiveImpact !== 0) {
        out.set(relPath, { fanIn, fanOut, transitiveImpact });
      }
    }
    return out;
  }

  async findCycles(scope: CycleScope, pathPattern?: string): Promise<CycleEntry[]> {
    return (await this.call("findCycles", { scope, pathPattern })) as CycleEntry[];
  }

  async listAdjacency(scope: CycleScope): Promise<Map<string, string[]>> {
    // The server serialises the `Map<string, string[]>` as `[key, value][]`
    // entries (a Map cannot JSON-serialise) — rebuild the Map here.
    const entries = (await this.call("listAdjacency", { scope })) as [string, string[]][];
    return new Map(entries);
  }

  async getPageRank(symbolId: SymbolId): Promise<number> {
    return (await this.call("getPageRank", { symbolId })) as number;
  }

  async getSupertypes(fqName: string): Promise<InheritanceEdge[]> {
    return (await this.call("getSupertypes", { fqName })) as InheritanceEdge[];
  }

  async getSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    return (await this.call("getSubtypes", { fqName })) as InheritanceEdge[];
  }

  async getTransitiveSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    return (await this.call("getTransitiveSubtypes", { fqName })) as InheritanceEdge[];
  }

  async loadHierarchySnapshot(): Promise<HierarchySnapshot> {
    // HierarchySnapshot is plain Records of arrays — JSON-serialisable as-is,
    // no Map rebuild needed (unlike getCalleeEdges / listAdjacency).
    return (await this.call("loadHierarchySnapshot", {})) as HierarchySnapshot;
  }

  // ── daemon-internal (NOT proxied) ──
  // `streamAdjacency` stays daemon-internal: the heavy graph analysis runs
  // inside the daemon (computeAndPersistCyclesAndSignals), so streaming the
  // adjacency over IPC is never correct. Throws on first iteration.

  streamAdjacency(_scope: CycleScope): AsyncIterableIterator<[source: string, target: string, weight?: number]> {
    const error = new UnsupportedDaemonReadError("streamAdjacency");
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<[source: string, target: string, weight?: number]>> {
        throw error;
      },
    };
  }
}
