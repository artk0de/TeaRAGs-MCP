import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import {
  DaemonConnectionLifecycle,
  type DaemonClientOptions,
  type LegacyToleratedDaemonOp,
  type StaleClientBuilds,
} from "./connection-lifecycle.js";
import type { DaemonHandshakeResult, DaemonOp, DaemonOpParamsMap } from "./protocol.js";

/**
 * The op-level transport one `DaemonGraphDbClient` speaks to the codegraph
 * daemon through (bd tea-rags-mcp-0qaht.38): one typed request per call, the
 * tolerated-legacy-op variant, the build handshake, the shutdown request, and
 * the read-only restriction. The socket itself — connect/retry, pending-call
 * settlement, the liveness watch, reconnect-and-replay — stays owned by the
 * `DaemonConnectionLifecycle` this channel constructs and delegates to.
 *
 * Statically importing this module loads `node:net` (through the lifecycle);
 * it is reached only from `daemon/client.ts`, which the pool imports
 * dynamically so direct/test mode never pays for the socket code.
 */
export class DaemonOpChannel {
  private readonly lifecycle: DaemonConnectionLifecycle;

  constructor(
    socketPath: string,
    readonly physicalCollectionName: PhysicalCollectionName,
    opts?: DaemonClientOptions,
  ) {
    this.lifecycle = new DaemonConnectionLifecycle(socketPath, physicalCollectionName, opts);
  }

  /** Connect to the daemon socket with bounded retry — see `DaemonConnectionLifecycle#init`. */
  async init(): Promise<void> {
    return this.lifecycle.init();
  }

  async close(): Promise<void> {
    return this.lifecycle.close();
  }

  /** Whether the channel still holds a live socket — see `DaemonGraphDbClient#isConnected`. */
  isConnected(): boolean {
    return this.lifecycle.isConnected();
  }

  /** Refuse every write-class op from now on — see `DaemonGraphDbClient#restrictToReads`. */
  restrictToReads(builds: StaleClientBuilds): void {
    this.lifecycle.restrictToReads(builds);
  }

  /**
   * Send one request and await its response — see `DaemonConnectionLifecycle#call`.
   * `params` is the op's `DaemonOpParamsMap` shape, so the proxy line and the
   * wire contract cannot drift apart (bd tea-rags-mcp-89k7k.35.6).
   */
  async call<Op extends DaemonOp>(
    op: Op,
    params: DaemonOpParamsMap[Op],
    options: { replayable?: boolean } = {},
  ): Promise<unknown> {
    return this.lifecycle.call(op, { ...params }, options);
  }

  /** `call` for a tolerated legacy op — see `DaemonConnectionLifecycle#callTolerated`. */
  async callTolerated<T, Op extends LegacyToleratedDaemonOp>(
    op: Op,
    params: DaemonOpParamsMap[Op],
    decode: (result: unknown) => T,
    fallback: () => T | Promise<T>,
  ): Promise<T> {
    return this.lifecycle.callTolerated(op, { ...params }, decode, fallback);
  }

  // ── build-version handshake (bd tea-rags-mcp-ji56r) ──

  /**
   * Exchange build fingerprints with the daemon. Sends the CLIENT's
   * fingerprint; resolves the daemon's (a legacy daemon returns null — no
   * fingerprint, treated by the pool as "proceed, no restart"). On a match or
   * legacy peer the daemon also opens + migrates + hydrates the collection.
   */
  async handshake(buildFingerprint?: string): Promise<DaemonHandshakeResult | null> {
    if (buildFingerprint !== undefined) this.lifecycle.rememberHandshakeFingerprint(buildFingerprint);
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
}

/**
 * The slice of `DaemonOpChannel` a per-store proxy sends its ops through. The
 * proxies depend on this rather than the whole channel: they never own the
 * connection, the handshake, or the read-only switch.
 */
export type DaemonOpCaller = Pick<DaemonOpChannel, "call" | "callTolerated">;
