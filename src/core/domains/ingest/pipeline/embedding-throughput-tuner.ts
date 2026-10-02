/**
 * EmbeddingThroughputTuner — the ONE owner of the embedding batch size and the
 * embed concurrency a run uses (bd tea-rags-mcp-7ju66).
 *
 * Three behaviours, one state machine per endpoint (URL + model):
 *
 * 1. Sticky downshift. A batch the server failed on SIZE halves the failure cap
 *    for every later batch, not just the failing one. A streak of successes
 *    doubles the cap back one step at a time; the climb then decides whether
 *    the freed size is actually worth using.
 * 2. Throughput hill-climb. Each size is measured over a few FULL batches as
 *    chars/s — input size, not text count, because chunk sizes vary — and the
 *    neighbours ×½ and ×2 inside [floor, cap] are probed; the tuner moves to a
 *    neighbour only when it beats the current size by `minImprovement`, and
 *    settles when neither does. A settled size is re-probed every
 *    `reprobeAfterBatches` batches so a drifting server is followed.
 * 3. Concurrency by locality. A loopback endpoint serialises requests anyway,
 *    so it runs at 1 — parallel batches only queue on the server and blur every
 *    throughput sample. A remote endpoint keeps the configured concurrency.
 *    The decision is re-made whenever an observation reports a different
 *    endpoint, which is how a primary ⇄ fallback failover reaches it.
 *
 * Pure: no clock reads beyond the injected `now` (used only to stamp a settle),
 * no timers, no I/O. The caller measures each batch and feeds it in.
 */

import type { EmbeddingThroughputOptimum } from "../../../contracts/types/registry.js";

/** Which server and model a batch went to — the tuner's state key. */
export interface EmbeddingEndpointIdentity {
  /** Active endpoint URL; undefined for a provider without one (in-process ONNX). */
  url?: string;
  model: string;
}

/** One embed call as the pipeline measured it. */
export interface EmbeddingBatchObservation {
  /** Texts in the batch. */
  size: number;
  /** Total characters across the batch's texts. */
  inputChars: number;
  durationMs: number;
  /** False only for a failure the server attributes to the batch SIZE. */
  ok: boolean;
  endpoint: EmbeddingEndpointIdentity;
}

/** What the pipeline should use for the next batches. */
export interface EmbeddingThroughputDecision {
  batchSize: number;
  concurrency: number;
}

export type EmbeddingThroughputAdaptationReason =
  | "seed"
  | "failure"
  | "recovery"
  | "probe"
  | "reprobe"
  | "settle"
  | "endpoint-local"
  | "endpoint-remote";

/** One change of the decision, for the pipeline debug log. */
export interface EmbeddingThroughputAdaptation {
  kind: "batchSize" | "concurrency";
  from: number;
  to: number;
  reason: EmbeddingThroughputAdaptationReason;
  /** Measured chars/s behind the change, when a measurement drove it. */
  charsPerSecond?: number;
  endpointUrl?: string;
}

export interface EmbeddingThroughputTunerConfig {
  /** Configured EMBEDDING_TUNE_BATCH_SIZE — the size is never above it. */
  ceiling: number;
  /** Smallest size the tuner may choose. */
  floor: number;
  /** Configured INGEST_PIPELINE_CONCURRENCY — what a remote endpoint runs at. */
  configuredConcurrency: number;
  /** Full batches measured per size before it is judged. Default 3. */
  samplesPerSize?: number;
  /** Consecutive successes before a failure cap is doubled back. Default 16. */
  recoveryStreak?: number;
  /** Settled batches between re-probes. Default 200. */
  reprobeAfterBatches?: number;
  /** Relative gain a neighbour must show to win. Default 0.05. */
  minImprovement?: number;
  /** Clock for the settle timestamp. Default Date.now. */
  now?: () => number;
  /** Stored optimum for an endpoint (a runtime hint); clamped to the bounds. */
  seed?: (endpoint: EmbeddingEndpointIdentity) => number | undefined;
}

/** A settled optimum together with the endpoint it belongs to. */
export interface EmbeddingEndpointThroughputOptimum {
  endpoint: EmbeddingEndpointIdentity;
  optimum: EmbeddingThroughputOptimum;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "[::1]"]);

/**
 * Is this embedding endpoint on the loopback interface? Undefined when there is
 * no URL or it cannot be parsed — the caller then keeps the configured
 * concurrency instead of guessing. A LAN address is remote: it is another
 * machine with its own GPU, whatever the network distance.
 */
export function isLoopbackEmbeddingEndpoint(url: string | undefined): boolean | undefined {
  if (url === undefined) return undefined;
  let hostname: string;
  try {
    ({ hostname } = new URL(url));
  } catch {
    return undefined;
  }
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(host) || host.endsWith(".localhost")) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

interface SizeSample {
  chars: number;
  ms: number;
  count: number;
}

interface EndpointTuneState {
  endpoint: EmbeddingEndpointIdentity;
  /** Best size known so far — where the climb returns between probes. */
  working: number;
  /** Size failures allow; ≤ ceiling. */
  cap: number;
  /** Size the next batches are formed at — `working`, or a neighbour under probe. */
  target: number;
  settled: boolean;
  samples: Map<number, SizeSample>;
  successStreak: number;
  batchesSinceSettle: number;
  concurrency: number;
  optimum?: EmbeddingThroughputOptimum;
}

function endpointKey(endpoint: EmbeddingEndpointIdentity): string {
  return `${endpoint.url ?? ""}|${endpoint.model}`;
}

export class EmbeddingThroughputTuner {
  private readonly ceiling: number;
  private readonly floor: number;
  private readonly samplesPerSize: number;
  private readonly recoveryStreak: number;
  private readonly reprobeAfterBatches: number;
  private readonly minImprovement: number;
  private readonly now: () => number;
  private readonly states = new Map<string, EndpointTuneState>();
  private pendingAdaptations: EmbeddingThroughputAdaptation[] = [];
  private active?: EndpointTuneState;

  constructor(private readonly config: EmbeddingThroughputTunerConfig) {
    this.ceiling = Math.max(1, config.ceiling);
    this.floor = Math.min(this.ceiling, Math.max(1, config.floor));
    this.samplesPerSize = config.samplesPerSize ?? 3;
    this.recoveryStreak = config.recoveryStreak ?? 16;
    this.reprobeAfterBatches = config.reprobeAfterBatches ?? 200;
    this.minImprovement = config.minImprovement ?? 0.05;
    this.now = config.now ?? Date.now;
  }

  /** Start (or resume) tuning against `endpoint`; returns the decision for the first batches. */
  begin(endpoint: EmbeddingEndpointIdentity): EmbeddingThroughputDecision {
    this.switchTo(endpoint);
    return this.decision();
  }

  /** The decision in force — the ceiling at the configured concurrency before `begin`. */
  decision(): EmbeddingThroughputDecision {
    const state = this.active;
    if (!state) return { batchSize: this.ceiling, concurrency: this.config.configuredConcurrency };
    return { batchSize: state.target, concurrency: state.concurrency };
  }

  /** Feed one measured batch; returns the decision for the next batches. */
  observe(observation: EmbeddingBatchObservation): EmbeddingThroughputDecision {
    const state = this.switchTo(observation.endpoint);
    if (!observation.ok) {
      this.downshift(state, observation.size);
      return this.decision();
    }

    state.successStreak++;
    if (state.cap < this.ceiling && state.successStreak >= this.recoveryStreak) {
      state.cap = Math.min(this.ceiling, state.cap * 2);
      state.successStreak = 0;
      this.continueClimb(state, "recovery");
    }

    if (state.settled) {
      state.batchesSinceSettle++;
      if (state.batchesSinceSettle >= this.reprobeAfterBatches) {
        state.samples.clear();
        this.continueClimb(state, "reprobe");
      }
      return this.decision();
    }

    if (observation.size === state.target && observation.durationMs > 0) {
      const sample = state.samples.get(state.target) ?? { chars: 0, ms: 0, count: 0 };
      sample.chars += observation.inputChars;
      sample.ms += observation.durationMs;
      sample.count++;
      state.samples.set(state.target, sample);
      if (sample.count >= this.samplesPerSize) this.continueClimb(state, "probe");
    }
    return this.decision();
  }

  /**
   * The decision changes since the last drain, oldest first — the caller logs
   * them. Pull-based so the tuner stays free of any logging dependency.
   */
  drainAdaptations(): EmbeddingThroughputAdaptation[] {
    const out = this.pendingAdaptations;
    this.pendingAdaptations = [];
    return out;
  }

  /** Every endpoint the run settled on, with what it settled at. */
  settledOptima(): EmbeddingEndpointThroughputOptimum[] {
    const out: EmbeddingEndpointThroughputOptimum[] = [];
    for (const state of this.states.values()) {
      if (state.optimum) out.push({ endpoint: { ...state.endpoint }, optimum: { ...state.optimum } });
    }
    return out;
  }

  private clamp(size: number): number {
    return Math.min(this.ceiling, Math.max(this.floor, Math.round(size)));
  }

  private emit(state: EndpointTuneState, adaptation: Omit<EmbeddingThroughputAdaptation, "endpointUrl">): void {
    this.pendingAdaptations.push({
      ...adaptation,
      ...(state.endpoint.url !== undefined ? { endpointUrl: state.endpoint.url } : {}),
    });
  }

  private concurrencyFor(endpoint: EmbeddingEndpointIdentity): number {
    return isLoopbackEmbeddingEndpoint(endpoint.url) === true ? 1 : this.config.configuredConcurrency;
  }

  /**
   * Make `endpoint` the active one, creating its state (seeded from the stored
   * optimum) on first sight. A change of endpoint re-decides concurrency and
   * resumes that endpoint's own batch size — a failover never inherits the
   * other server's curve.
   */
  private switchTo(endpoint: EmbeddingEndpointIdentity): EndpointTuneState {
    const key = endpointKey(endpoint);
    const previous = this.active;
    if (previous && endpointKey(previous.endpoint) === key) return previous;

    let state = this.states.get(key);
    if (!state) {
      const seeded = this.config.seed?.(endpoint);
      const start = seeded !== undefined && seeded > 0 ? this.clamp(seeded) : this.ceiling;
      state = {
        endpoint: { ...endpoint },
        working: start,
        cap: this.ceiling,
        target: start,
        settled: false,
        samples: new Map(),
        successStreak: 0,
        batchesSinceSettle: 0,
        concurrency: this.concurrencyFor(endpoint),
      };
      this.states.set(key, state);
    }
    this.active = state;

    const fromSize = previous ? previous.target : this.ceiling;
    const fromConcurrency = previous ? previous.concurrency : this.config.configuredConcurrency;
    if (state.target !== fromSize) {
      this.emit(state, { kind: "batchSize", from: fromSize, to: state.target, reason: "seed" });
    }
    if (state.concurrency !== fromConcurrency) {
      const local = isLoopbackEmbeddingEndpoint(endpoint.url) === true;
      this.emit(state, {
        kind: "concurrency",
        from: fromConcurrency,
        to: state.concurrency,
        reason: local ? "endpoint-local" : "endpoint-remote",
      });
    }
    return state;
  }

  private rate(state: EndpointTuneState, size: number): number | undefined {
    const sample = state.samples.get(size);
    if (!sample || sample.count < this.samplesPerSize || sample.ms <= 0) return undefined;
    return (sample.chars / sample.ms) * 1000;
  }

  private neighbours(state: EndpointTuneState, size: number): number[] {
    const out: number[] = [];
    const up = Math.min(size * 2, state.cap);
    if (up > size) out.push(up);
    const down = Math.max(Math.floor(size / 2), this.floor);
    if (down < size) out.push(down);
    return out;
  }

  /**
   * Decide what to measure next, or settle. Measures `working` first, then each
   * unmeasured neighbour; once all are known, moves to a neighbour that beats
   * `working` by `minImprovement` and repeats from there. Every move strictly
   * raises the measured rate, so the loop terminates.
   */
  private continueClimb(state: EndpointTuneState, reason: "probe" | "reprobe" | "recovery"): void {
    state.settled = false;
    for (;;) {
      const workingRate = this.rate(state, state.working);
      if (workingRate === undefined) {
        this.retarget(state, state.working, reason);
        return;
      }
      const neighbours = this.neighbours(state, state.working);
      const unmeasured = neighbours.find((size) => this.rate(state, size) === undefined);
      if (unmeasured !== undefined) {
        this.retarget(state, unmeasured, reason);
        return;
      }
      let best = state.working;
      let bestRate = workingRate;
      for (const size of neighbours) {
        const r = this.rate(state, size) ?? 0;
        if (r > bestRate) {
          best = size;
          bestRate = r;
        }
      }
      if (best !== state.working && bestRate > workingRate * (1 + this.minImprovement)) {
        state.working = best;
        continue;
      }
      this.settle(state, workingRate);
      return;
    }
  }

  private retarget(state: EndpointTuneState, size: number, reason: EmbeddingThroughputAdaptationReason): void {
    if (state.target === size) return;
    const from = state.target;
    state.target = size;
    this.emit(state, { kind: "batchSize", from, to: size, reason, charsPerSecond: this.rate(state, from) });
  }

  private settle(state: EndpointTuneState, charsPerSecond: number): void {
    const from = state.target;
    state.target = state.working;
    state.settled = true;
    state.batchesSinceSettle = 0;
    state.optimum = {
      batchSize: state.working,
      concurrency: state.concurrency,
      charsPerSecond,
      settledAt: new Date(this.now()).toISOString(),
    };
    this.emit(state, { kind: "batchSize", from, to: state.working, reason: "settle", charsPerSecond });
  }

  /**
   * The server failed a batch of `failedSize` texts on its size: cap every later
   * batch at half of it. Samples of sizes above the new cap are dropped (they are
   * no longer candidates); the rest stay, so the climb resumes from what it
   * already knows instead of re-measuring. A late failure of a size already
   * above the cap changes nothing.
   */
  private downshift(state: EndpointTuneState, failedSize: number): void {
    state.successStreak = 0;
    const newCap = Math.max(this.floor, Math.floor(failedSize / 2));
    if (newCap >= state.cap) return;
    state.cap = newCap;
    for (const size of [...state.samples.keys()]) {
      if (size > newCap) state.samples.delete(size);
    }
    const from = state.target;
    state.working = Math.min(state.working, newCap);
    state.target = Math.min(state.target, newCap);
    state.settled = false;
    if (state.target !== from) {
      this.emit(state, { kind: "batchSize", from, to: state.target, reason: "failure" });
    }
    if (state.target !== state.working) this.retarget(state, state.working, "failure");
  }
}
