/**
 * Kev behind the GPU session broker: the card serves the embedding
 * llama-servers until a pass leases it. `health` and `version` read the
 * broker, so a pass answered from the verdict cache never takes the GPU;
 * `acquire` leases Kev, and only then does `resolveGroup` reach it, at the
 * URL the lease names.
 */

import { hostname } from "node:os";

import type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualProviderLease,
  ResidualQuestionGroup,
} from "../../contracts/types/codegraph-residual.js";
import { KevSessionLostError, KevSessionUnavailableError } from "./errors.js";
import type { KevSession, KevSessionClient } from "./kev-session-client.js";

const DEFAULT_TTL_SEC = 120;
/** Signals that end a CLI run; the lease is returned before the process goes. */
const RELEASE_ON: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The slice of `process` the lease guards against an interrupted run. */
export interface ProcessSignals {
  pid: number;
  once: (signal: NodeJS.Signals, listener: () => void) => unknown;
  removeListener: (signal: NodeJS.Signals, listener: () => void) => unknown;
  listenerCount: (signal: NodeJS.Signals) => number;
  kill: (pid: number, signal: NodeJS.Signals) => unknown;
}

export interface BrokeredResidualProviderOptions {
  session: KevSessionClient;
  threshold: number;
  /** Builds the provider that asks Kev at the lease's URL. */
  kevProvider: (kevUrl: string) => ResidualModelProvider;
  /** Default `<hostname>:<pid>`. */
  holder?: string;
  /** Lease ttl the broker enforces; default 120. */
  ttlSec?: number;
  /** Default ttl / 3. */
  heartbeatMs?: number;
}

export interface BrokeredResidualProviderDeps {
  signals?: ProcessSignals;
}

interface ActiveLease {
  session: KevSession;
  kev: ResidualModelProvider;
  lost: boolean;
  heartbeat: NodeJS.Timeout;
  onSignal: Map<NodeJS.Signals, () => void>;
}

export class BrokeredResidualProvider implements ResidualModelProvider {
  readonly id = "kev";
  readonly threshold: number;
  private readonly session: KevSessionClient;
  private readonly kevProvider: (kevUrl: string) => ResidualModelProvider;
  private readonly holder: string;
  private readonly ttlSec: number;
  private readonly heartbeatMs: number;
  private readonly signals: ProcessSignals;
  /** The run `version` reported; a lease whose Kev serves another is refused. */
  private announcedRun: string | undefined;
  private active: ActiveLease | undefined;

  constructor(options: BrokeredResidualProviderOptions, deps: BrokeredResidualProviderDeps = {}) {
    this.session = options.session;
    this.threshold = options.threshold;
    this.kevProvider = options.kevProvider;
    this.signals = deps.signals ?? process;
    this.holder = options.holder ?? `${hostname()}:${this.signals.pid}`;
    this.ttlSec = options.ttlSec ?? DEFAULT_TTL_SEC;
    this.heartbeatMs = options.heartbeatMs ?? (this.ttlSec * 1000) / 3;
  }

  version = async (): Promise<string> => {
    const { kevRun } = await this.session.state();
    if (kevRun === undefined) throw new KevSessionUnavailableError(this.session.url, "broker state names no Kev run");
    this.announcedRun = kevRun;
    return kevRun;
  };

  health = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    try {
      await this.session.state();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  acquire = async (): Promise<ResidualProviderLease> => {
    const session = await this.session.acquire(this.holder, this.ttlSec);
    const kev = this.kevProvider(session.kevUrl);
    const active: ActiveLease = {
      session,
      kev,
      lost: false,
      heartbeat: setInterval(() => void this.beat(active), this.heartbeatMs),
      onSignal: new Map(),
    };
    active.heartbeat.unref();
    this.active = active;
    for (const signal of RELEASE_ON) {
      const listener = (): void => void this.releaseAndReraise(active, signal);
      active.onSignal.set(signal, listener);
      this.signals.once(signal, listener);
    }
    try {
      await this.checkServedRun(kev);
    } catch (error) {
      await this.release(active);
      throw error;
    }
    return { release: async () => this.release(active) };
  };

  resolveGroup = async (group: ResidualQuestionGroup): Promise<ResidualAnswer[]> => {
    const { active } = this;
    if (!active) throw new Error("BrokeredResidualProvider.resolveGroup called without an acquired lease");
    if (active.lost) throw new KevSessionLostError(this.session.url, active.session.lease);
    try {
      return await active.kev.resolveGroup(group);
    } catch (error) {
      if (active.lost) throw new KevSessionLostError(this.session.url, active.session.lease);
      throw error;
    }
  };

  private async checkServedRun(kev: ResidualModelProvider): Promise<void> {
    if (this.announcedRun === undefined) return;
    const served = await kev.version();
    if (served !== this.announcedRun) {
      throw new KevSessionUnavailableError(
        this.session.url,
        `Kev serves ${served}, the broker announced ${this.announcedRun}`,
      );
    }
  }

  /** A failed beat other than 404 is retried on the next tick; the broker expires the lease at its ttl. */
  private async beat(active: ActiveLease): Promise<void> {
    try {
      await this.session.heartbeat(active.session.lease);
    } catch (error) {
      if (error instanceof KevSessionLostError) active.lost = true;
    }
  }

  /** Idempotent and never throws: a DELETE that fails is covered by the broker's lease watchdog. */
  private async release(active: ActiveLease): Promise<void> {
    if (this.active !== active) return;
    this.active = undefined;
    clearInterval(active.heartbeat);
    for (const [signal, listener] of active.onSignal) this.signals.removeListener(signal, listener);
    try {
      await this.session.release(active.session.lease);
    } catch {
      // The lease expires at its ttl on the broker, which restores the embedders.
    }
  }

  /** Our `once` listener is gone by now; with no other listener the default action (exit) is restored by re-raising. */
  private async releaseAndReraise(active: ActiveLease, signal: NodeJS.Signals): Promise<void> {
    await this.release(active);
    if (this.signals.listenerCount(signal) === 0) this.signals.kill(this.signals.pid, signal);
  }
}
