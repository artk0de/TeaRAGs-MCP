/**
 * The live connection to a Qdrant server — and everything that keeps it live.
 *
 * Every other Qdrant collaborator holds one of these and issues its calls
 * through {@link QdrantConnection.call}, which is the single place where a
 * transport failure is classified. That funnel is what lets one object own the
 * whole "stay connected" story:
 *
 * - the REST client itself, which is REPLACED (not mutated) when an embedded
 *   daemon comes back on a different port, so collaborators must always read
 *   `connection.client` at call time rather than caching it;
 * - reconnection — re-resolving the daemon URL and retrying the failed call once;
 * - corrupt-collection quarantine — a daemon bricked by a half-written versioned
 *   collection is unbrickable by reconnect alone, so the offending directory is
 *   moved aside BEFORE the respawn;
 * - liveness/identity probes (`checkHealth`, `getServerVersion`) that describe
 *   the server rather than anything stored in it.
 *
 * The alias manager lives here too, because it wraps the client and therefore
 * has to be discarded whenever the client is.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QdrantClient } from "@qdrant/js-client-rest";

import { QdrantAliasManager } from "./aliases.js";
import {
  parseCorruptCollection,
  QDRANT_CRASH_LOG_NAME,
  quarantineCorruptCollection,
} from "./embedded/corruption-recovery.js";
import type { StartupPhase } from "./embedded/types.js";
import { QdrantRecoveringError, QdrantStartingError, QdrantUnavailableError } from "./errors.js";

/**
 * Build the REST client with the library's own version probe turned OFF.
 *
 * `@qdrant/js-client-rest` fetches the server version from inside its
 * constructor, unawaited, to warn about client/server incompatibility. This
 * package already owns that decision and owns it better:
 * `.qdrant-required-version` is the single source of truth, the embedded daemon
 * runs exactly that version, and `checkExternalQdrantVersion` validates an
 * external `QDRANT_URL` at startup with a typed error rather than a log line.
 *
 * Leaving the probe on costs two things and buys none. It makes constructing a
 * manager perform network I/O, so every construction against a server that is
 * not up yet — a cold embedded daemon, any unit test — prints "Failed to obtain
 * server version" to stderr. And because the write is unawaited it can still be
 * in flight when the process that started it goes away: in a vitest worker the
 * pending console write surfaces as `EnvironmentTeardownError: Closing rpc while
 * "onUserConsoleLog" was pending`, which fails the run with every test passing.
 */
function createRestClient(url: string, apiKey?: string): QdrantClient {
  return new QdrantClient({ url, apiKey, checkCompatibility: false });
}

export interface EmbeddedDaemonProbe {
  /** Current startup phase of the embedded daemon, or null if daemon is dead / not an embedded daemon. */
  startupPhase: () => StartupPhase | null;
  pid: number;
  storagePath: string;
}

export class QdrantConnection {
  /**
   * The live REST client. Public and mutable on purpose: `tryReconnect` swaps it
   * wholesale, and collaborators resolve it per call so they never hold a stale one.
   */
  client: QdrantClient;

  /** URL the client currently points at — an embedded daemon can move ports. */
  url: string;

  readonly daemon?: EmbeddedDaemonProbe;

  private readonly apiKey?: string;
  private readonly reconnect?: () => Promise<string | null>;
  private _aliases?: QdrantAliasManager;

  constructor(
    url = "http://localhost:6333",
    apiKey?: string,
    reconnect?: () => Promise<string | null>,
    daemon?: EmbeddedDaemonProbe,
  ) {
    this.url = url;
    this.apiKey = apiKey;
    this.reconnect = reconnect;
    this.daemon = daemon;
    this.client = createRestClient(url, apiKey);
  }

  get aliases(): QdrantAliasManager {
    return (this._aliases ??= new QdrantAliasManager(this.client));
  }

  /**
   * Guard all Qdrant client calls through a single entry point.
   * Catches connection errors (fetch failed, ECONNREFUSED) and converts
   * them to a typed error. Business errors (404, 409) pass through.
   *
   * For embedded mode: on connection error, tries to reconnect to a daemon
   * that may have restarted on a different port, then retries once.
   *
   * If the daemon is known-alive (embedded mode, pid still running) but the
   * HTTP port is not listening — the daemon is recovering shards. We throw
   * QdrantStartingError so callers can distinguish "not ready yet, retry"
   * from "really unreachable, fix your config".
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (!isConnectionError(error)) throw error;
      // A dead embedded daemon may have been bricked by a corrupt versioned
      // collection (killed reindex → WAL replay panic on boot). Quarantine it
      // BEFORE reconnect so the respawn boots clean (tea-rags-mcp-mh7nr).
      this.quarantineCorruptCollectionIfDead();
      let connError: unknown = error;
      if (await this.tryReconnect()) {
        try {
          return await fn();
        } catch (retryError: unknown) {
          if (!isConnectionError(retryError)) throw retryError;
          // The freshly-respawned daemon is still booting — fall through to
          // phase classification so a RETRYABLE "starting" surfaces instead of
          // a bare "fetch failed" that fails the whole run.
          connError = retryError;
        }
      }
      const cause = connError instanceof Error ? connError : undefined;
      const daemonCtx = { pid: this.daemon?.pid, storagePath: this.daemon?.storagePath };
      const phase = this.daemon?.startupPhase();
      if (phase === "starting") throw new QdrantStartingError(this.url, daemonCtx, cause);
      if (phase === "recovering") throw new QdrantRecoveringError(this.url, daemonCtx, cause);
      throw new QdrantUnavailableError(this.url, cause);
    }
  }

  /**
   * Attempt to re-resolve the embedded daemon URL (re-read port, or respawn a
   * dead daemon). Returns true if the URL was updated and a retry is warranted.
   */
  private async tryReconnect(): Promise<boolean> {
    if (!this.reconnect) return false;
    const newUrl = await this.reconnect();
    if (!newUrl) return false;
    this.url = newUrl;
    this.client = createRestClient(newUrl, this.apiKey);
    this._aliases = undefined;
    return true;
  }

  /** Collections already moved aside this session — a name recurring here means
   *  the quarantine did not help, so we stop rather than loop forever. */
  private readonly quarantinedCorrupt = new Set<string>();

  /**
   * If the embedded daemon is DEAD and its crash log names a collection that
   * panicked the shard load, move that collection aside so the next respawn
   * boots clean. A no-op for a live daemon, an external qdrant, a healthy crash
   * log, or a collection already tried this session (dedup guard against an
   * infinite quarantine loop). The respawn itself is the caller's `tryReconnect`.
   */
  private quarantineCorruptCollectionIfDead(): void {
    const { daemon } = this;
    if (daemon?.startupPhase() !== null) return; // only a dead daemon
    let crashLog: string;
    try {
      crashLog = readFileSync(join(daemon.storagePath, QDRANT_CRASH_LOG_NAME), "utf8");
    } catch {
      return; // no crash log (external qdrant, or never captured)
    }
    const corrupt = parseCorruptCollection(crashLog);
    if (!corrupt || this.quarantinedCorrupt.has(corrupt)) return;
    this.quarantinedCorrupt.add(corrupt);
    try {
      const dest = quarantineCorruptCollection(daemon.storagePath, corrupt, Date.now());
      console.error(`[tea-rags] Quarantined corrupt Qdrant collection '${corrupt}' → ${dest}; respawning daemon`);
    } catch {
      /* dir gone / move raced → fall through to the normal unavailable path */
    }
  }

  /** Lightweight health check — returns true if Qdrant is reachable. */
  async checkHealth(): Promise<boolean> {
    try {
      await this.call(async () => this.client.getCollections());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Best-effort probe of the RUNNING daemon's reported version via a raw GET on
   * the root endpoint (the typed SDK exposes no version method). Mirrors the
   * fetch shape of `checkExternalQdrantVersion`. For embedded mode this is the
   * actual running binary; for external it is the user's server. Returns the
   * reported version string, or `undefined` on ANY failure — this is a status
   * probe and MUST NOT throw, so it can never break `get_index_status`.
   */
  async getServerVersion(): Promise<string | undefined> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) headers["api-key"] = this.apiKey;
      const res = await fetch(`${this.url}/`, {
        headers,
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { version?: unknown } | null;
      const raw = body?.version;
      return typeof raw === "string" ? raw : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Detect network/connection errors vs Qdrant business errors.
 * Business errors (404, 400, 409) have an HTTP status — these are NOT connection errors.
 * Connection errors: fetch failed, ECONNREFUSED, ENOTFOUND, socket hang up, etc.
 */
function isConnectionError(error: unknown): boolean {
  // Qdrant client attaches `status` for HTTP errors — not a connection error
  if (typeof error === "object" && error !== null && "status" in error) {
    const { status } = error as { status: number };
    if (typeof status === "number" && status > 0) return false;
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("fetch failed") ||
      msg.includes("econnrefused") ||
      msg.includes("enotfound") ||
      msg.includes("socket hang up") ||
      msg.includes("network error") ||
      msg.includes("failed to fetch") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout")
    );
  }

  return false;
}
