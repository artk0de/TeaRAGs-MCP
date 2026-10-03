/**
 * EmbeddingThroughputTuner — the ONE owner of the embedding batch size and the
 * embed concurrency a run uses (bd tea-rags-mcp-7ju66).
 *
 * Five behaviours, one state machine per embedding identity (provider +
 * endpoint set + model):
 *
 * 1. Sticky downshift. A batch the server failed on SIZE halves the failure cap
 *    for every later batch, not just the failing one. A streak of successes
 *    doubles the cap back one step at a time; the climb then decides whether
 *    the freed size is actually worth using.
 * 2. Throughput hill-climb. Each size is measured over a few FULL batches as
 *    chars/s — input size, not text count, because chunk sizes vary — and the
 *    neighbours ×½ and ×2 inside [floor, cap] are probed; the tuner moves to a
 *    neighbour only when it beats the current size by `minImprovement`, and
 *    settles when neither does. Every `reprobeAfterBatches` settled batches the
 *    settled point is re-probed UPWARD only (bd tea-rags-mcp-cyw2r): size ×2
 *    below the cap, then concurrency ×2 below the ceiling, each adopted only
 *    when it beats the working point by `minImprovement`; a size move hands
 *    concurrency back to the full climb. At both ceilings the re-probe is a
 *    no-op. Getting SLOWER is the slowdown guard's job (5), not the re-probe's.
 * 3. Concurrency hill-climb (bd tea-rags-mcp-gdo7h.4). Once the size settles,
 *    concurrency is climbed the same way — ×½ and ×2 inside
 *    [1, configuredConcurrency] — but judged on AGGREGATE chars/s: the input
 *    chars of every full batch the probe saw, over the wall-clock span from the
 *    earliest start to the latest end. Per-call chars/s would always crown 1.
 *    A probe needs `samplesPerSize` rounds of in-flight batches
 *    (`samplesPerSize × concurrency` observations), and a batch that started
 *    before the probe did ran under the previous concurrency, so it is not
 *    counted. Whether a server serialises (Ollama on loopback converges to 1)
 *    is measured, never inferred from its address. A size re-probe, failure or
 *    recovery abandons the concurrency climb back to the working value; it
 *    restarts when the size settles again. Each endpoint seeds both values from
 *    its own stored optimum, so a primary ⇄ fallback failover never inherits the
 *    other server's shape.
 * 4. Best measured point (bd tea-rags-mcp-cyw2r). Every complete, trusted
 *    aggregate window is a measured (batchSize, concurrency) point; the run's
 *    optimum is the fastest of them, not the point it happened to settle on —
 *    a run that ends mid-climb still hands its best level to the next one. A
 *    window that saw a producer-starved batch or a server failure is not a
 *    measurement. `settledOptima` reconciles that best with the stored optimum
 *    (`EmbeddingThroughputTuner#optimumToPersist`).
 * 5. Trusted seed and slowdown guard (bd tea-rags-mcp-cyw2r). An endpoint with
 *    a stored AGGREGATE optimum starts settled at it — no size probes, no
 *    concurrency climb; the record has no age limit. Every settled point (a
 *    trusted seed, or the run's own concurrency settle) is guarded: a full,
 *    unstarved, failure-free window below `SETTLED_THROUGHPUT_SLOWDOWN_SHARE`
 *    of its reference rate drops the run into the full climb (`seed-slower` /
 *    `settled-slower`) — and so does the first window an upward re-probe
 *    re-measures the working point with.
 *
 * Pure: no clock reads beyond the injected `now` (stamps a settle, opens a
 * concurrency probe, and dates an observation that carries no `startedAt`),
 * no timers, no I/O. The caller measures each batch and feeds it in.
 */

import type { EmbeddingThroughputOptimum } from "../../../contracts/types/registry.js";

/**
 * Ceiling of the concurrency climb when INGEST_PIPELINE_CONCURRENCY is unset.
 * An unset value keeps every other consumer of pipeline concurrency at 1 — the
 * embed concurrency alone may climb, from 1 (or the stored optimum) up to this.
 * An explicit value, even 1, replaces it as the hard ceiling.
 */
export const IMPLICIT_EMBEDDING_CONCURRENCY_CEILING = 8;

/**
 * Share of recent batches that must be producer-starved for the tuner to treat
 * the embed stage as PRODUCER-bound (bd tea-rags-mcp-y1ynz) — also the share at
 * which a run's summary reports `producerStarved`.
 */
export const PRODUCER_STARVED_BATCH_SHARE = 0.5;

/** Batches the starvation share is measured over, per endpoint. */
export const PRODUCER_STARVATION_WINDOW = 16;

/**
 * Share of its reference aggregate chars/s a settled point must keep (bd
 * tea-rags-mcp-cyw2r) — the stored rate of a trusted seed, or the rate the
 * run's own concurrency climb settled at. A full window at the settled point
 * below it means the server got slower, and the run drops into the full climb
 * (`seed-slower` / `settled-slower`). Wide on purpose: window-to-window noise on
 * a shared GPU is tens of percent, and a guard that trips on noise turns every
 * small run back into a full climb.
 */
export const SETTLED_THROUGHPUT_SLOWDOWN_SHARE = 0.7;

/**
 * Which embedding identity a batch went to — the tuner's state key and the key
 * of the optimum it stores (bd tea-rags-mcp-y1ynz): provider, the endpoint (or
 * endpoint SET, for a provider that fans one batch over several), and model.
 * Change any of them and the stored optimum does not apply.
 */
export interface EmbeddingEndpointIdentity {
  /** Provider kind (`EmbeddingProvider.getProviderName`). Absent only in callers that predate it. */
  provider?: string;
  /**
   * Endpoint the batch went to — the whole endpoint set for a fan-out provider
   * (`EmbeddingProvider.getThroughputTuneEndpointUrl`); undefined for a
   * provider without one (in-process ONNX).
   */
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
  /**
   * Epoch ms the call started. Optional: when absent the tuner takes
   * `now() - durationMs`, exact for a caller that observes on completion.
   */
  startedAt?: number;
  /** False only for a failure the server attributes to the batch SIZE. */
  ok: boolean;
  endpoint: EmbeddingEndpointIdentity;
  /**
   * The formation timeout flushed this batch below its target size while an
   * embed slot sat idle — the server was waiting for the chunk producer (bd
   * tea-rags-mcp-y1ynz). Absent when the caller cannot tell.
   */
  producerStarved?: boolean;
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
  | "concurrency-probe"
  | "concurrency-settle"
  /** The concurrency climb is held: most recent batches were producer-starved. */
  | "producer-starved"
  /** A trusted seed measured below SETTLED_THROUGHPUT_SLOWDOWN_SHARE of its stored rate; the climb restarts. */
  | "seed-slower"
  /** The run's own settled point measured below SETTLED_THROUGHPUT_SLOWDOWN_SHARE of its settle rate. */
  | "settled-slower";

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
  /**
   * Ceiling of the concurrency climb: an explicit INGEST_PIPELINE_CONCURRENCY,
   * or IMPLICIT_EMBEDDING_CONCURRENCY_CEILING when it is unset.
   */
  configuredConcurrency: number;
  /**
   * Concurrency an endpoint without a stored optimum starts at, clamped to
   * [1, configuredConcurrency]. Default configuredConcurrency.
   */
  initialConcurrency?: number;
  /** Full batches measured per size before it is judged. Default 3. */
  samplesPerSize?: number;
  /** Consecutive successes before a failure cap is doubled back. Default 16. */
  recoveryStreak?: number;
  /** Settled batches between upward re-probes. Default 1000. */
  reprobeAfterBatches?: number;
  /** Relative gain a neighbour must show to win. Default 0.05. */
  minImprovement?: number;
  /** Clock for the settle timestamp. Default Date.now. */
  now?: () => number;
  /** Stored optimum for an endpoint (a runtime hint); clamped to the bounds. */
  seed?: (endpoint: EmbeddingEndpointIdentity) => number | undefined;
  /** Stored concurrency for an endpoint (a runtime hint); clamped to [1, configuredConcurrency]. */
  seedConcurrency?: (endpoint: EmbeddingEndpointIdentity) => number | undefined;
  /**
   * The whole stored optimum for an endpoint (bd tea-rags-mcp-cyw2r). Seeds the
   * size and the concurrency where `seed` / `seedConcurrency` are absent, makes
   * an aggregate record a TRUSTED seed (the run starts settled at it), and is
   * what the run's best measured point is reconciled against before it is
   * persisted.
   */
  storedOptimum?: (endpoint: EmbeddingEndpointIdentity) => EmbeddingThroughputOptimum | undefined;
}

/** A settled optimum together with the endpoint it belongs to. */
export interface EmbeddingEndpointThroughputOptimum {
  endpoint: EmbeddingEndpointIdentity;
  optimum: EmbeddingThroughputOptimum;
}

interface SizeSample {
  chars: number;
  ms: number;
  count: number;
}

/** Full batches seen at one concurrency, measured as one wall-clock window. */
interface ConcurrencySample {
  chars: number;
  count: number;
  firstStart: number;
  lastEnd: number;
  /**
   * A producer-starved batch or a server failure arrived while the window was
   * open: the climb may still judge it, but it is no measurement to persist.
   */
  tainted: boolean;
}

/** A complete, trusted aggregate window — one measured (batchSize, concurrency) point. */
interface MeasuredThroughputPoint {
  batchSize: number;
  concurrency: number;
  charsPerSecond: number;
  measuredAt: number;
}

function throughputPointKey(batchSize: number, concurrency: number): string {
  return `${batchSize}x${concurrency}`;
}

function emptyConcurrencySample(): ConcurrencySample {
  return { chars: 0, count: 0, firstStart: Infinity, lastEnd: -Infinity, tainted: false };
}

/**
 * Where the concurrency climb stands: `idle` while the size is still climbing
 * (concurrency held at `concurrencyWorking`), `climbing` once the size settled,
 * `settled` when no neighbour beat the working concurrency.
 */
type ConcurrencyClimbPhase = "idle" | "climbing" | "settled";

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
  /** Concurrency in force — `concurrencyWorking`, or a neighbour under probe. */
  concurrency: number;
  /** Best concurrency known so far — where the climb returns between probes. */
  concurrencyWorking: number;
  concurrencyPhase: ConcurrencyClimbPhase;
  concurrencySamples: Map<number, ConcurrencySample>;
  /** Clock at which the current concurrency probe opened; earlier-started batches don't count. */
  concurrencyProbeStartedAt: number;
  /** Producer-starved flags of the latest batches, oldest first, at most PRODUCER_STARVATION_WINDOW. */
  starvationWindow: boolean[];
  /** The concurrency climb is held because the producer cannot keep the slots busy. */
  concurrencyHeldForStarvation: boolean;
  /** The size settle point — persisted only when the run measured no aggregate point. */
  optimum?: EmbeddingThroughputOptimum;
  /** What the registry held for this endpoint when the run first saw it. */
  storedOptimum?: EmbeddingThroughputOptimum;
  /** The (clamped) point a stored optimum seeded the run at. */
  seedPointKey?: string;
  /** Measured points of the current climb episode, by `throughputPointKey`. */
  measuredPoints: Map<string, MeasuredThroughputPoint>;
  /** The size climb restarted since the last measurement: the next one opens a new episode. */
  measuredPointsStale: boolean;
  /** Every point the run measured, across episodes. */
  measuredPointKeys: Set<string>;
  /**
   * The aggregate chars/s the settled point is held to — the stored rate of a
   * trusted seed, or the rate the run's own concurrency climb settled at.
   * Undefined while anything is climbing.
   */
  slowdownGuardCharsPerSecond?: number;
  /** Adaptation reason the guard trips with: `seed-slower` for a trusted seed, else `settled-slower`. */
  slowdownGuardReason: "seed-slower" | "settled-slower";
  /** The slowdown guard's open window at the settled point. */
  slowdownGuardSample: ConcurrencySample;
  /** Clock the guard window opened at; earlier-started batches do not count. */
  slowdownGuardStartedAt: number;
  /**
   * A periodic re-probe is in progress: it probes only UPWARD (size ×2,
   * concurrency ×2) — slowdowns belong to the slowdown guard.
   */
  upwardReprobe: boolean;
  /** Working size when the upward re-probe began — a size move hands concurrency back to the full climb. */
  upwardReprobeStartSize: number;
  /**
   * The slowdown guard's reference when the upward re-probe began: the re-probe
   * re-measures the working point first, and that measurement is held to it.
   */
  upwardReprobeReferenceCharsPerSecond?: number;
}

function endpointKey(endpoint: EmbeddingEndpointIdentity): string {
  return `${endpoint.provider ?? ""}|${endpoint.url ?? ""}|${endpoint.model}`;
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
    this.reprobeAfterBatches = config.reprobeAfterBatches ?? 1000;
    this.minImprovement = config.minImprovement ?? 0.05;
    this.now = config.now ?? Date.now;
  }

  /** Start (or resume) tuning against `endpoint`; returns the decision for the first batches. */
  begin(endpoint: EmbeddingEndpointIdentity): EmbeddingThroughputDecision {
    this.switchTo(endpoint);
    return this.decision();
  }

  /** The decision in force — the ceiling at the initial concurrency before `begin`. */
  decision(): EmbeddingThroughputDecision {
    const state = this.active;
    if (!state) return { batchSize: this.ceiling, concurrency: this.initialConcurrency };
    return { batchSize: state.target, concurrency: state.concurrency };
  }

  /** Feed one measured batch; returns the decision for the next batches. */
  observe(observation: EmbeddingBatchObservation): EmbeddingThroughputDecision {
    const state = this.switchTo(observation.endpoint);
    if (!observation.ok) {
      this.taintMeasurementWindows(state);
      this.downshift(state, observation.size);
      return this.decision();
    }

    this.recordStarvation(state, observation);
    if (observation.producerStarved === true) this.taintMeasurementWindows(state);
    state.successStreak++;
    if (state.cap < this.ceiling && state.successStreak >= this.recoveryStreak) {
      state.cap = Math.min(this.ceiling, state.cap * 2);
      state.successStreak = 0;
      this.continueClimb(state, "recovery");
    }

    if (state.settled) {
      state.batchesSinceSettle++;
      if (state.batchesSinceSettle >= this.reprobeAfterBatches) {
        this.startUpwardReprobe(state);
      } else if (state.concurrencyPhase === "climbing") {
        if (this.isProducerStarved(state)) {
          this.holdConcurrencyClimbForStarvation(state);
        } else {
          this.releaseStarvationHold(state);
          this.sampleConcurrency(state, observation);
        }
      } else if (state.slowdownGuardCharsPerSecond !== undefined) {
        this.guardSettledPoint(state, observation, state.slowdownGuardCharsPerSecond);
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

  /**
   * The optimum to persist for every endpoint the run measured something on
   * (bd tea-rags-mcp-cyw2r): its best measured point, reconciled with the
   * stored one by `optimumToPersist`. An endpoint whose run measured nothing
   * new — a pure trusted-seed run, a short or starved one — is absent, so its
   * stored record stays exactly as it was.
   */
  settledOptima(): EmbeddingEndpointThroughputOptimum[] {
    const out: EmbeddingEndpointThroughputOptimum[] = [];
    for (const state of this.states.values()) {
      const optimum = this.optimumToPersist(state);
      if (optimum) out.push({ endpoint: { ...state.endpoint }, optimum });
    }
    return out;
  }

  /**
   * The merge rule. An aggregate best is persisted when nothing is stored, when
   * the stored record is not an aggregate measurement (a per-batch rate is not
   * comparable), when it is at least as fast as the stored rate, or when the
   * run measured the point the stored optimum seeded it at — then the run's
   * evidence about that point is newer than the record, so a slower server
   * lowers it (and a stored point the current bounds clamp away gives way to
   * what the run can reach). A worse run that never re-measured the seed point
   * leaves the record alone. Without an aggregate best, the size settle point
   * is persisted only where nothing is stored.
   */
  private optimumToPersist(state: EndpointTuneState): EmbeddingThroughputOptimum | undefined {
    const stored = state.storedOptimum;
    const best = this.bestMeasuredPoint(state);
    if (!best) {
      return stored === undefined && state.optimum ? { ...state.optimum, measurement: "per-batch" } : undefined;
    }
    const optimum: EmbeddingThroughputOptimum = {
      batchSize: best.batchSize,
      concurrency: best.concurrency,
      charsPerSecond: best.charsPerSecond,
      settledAt: new Date(best.measuredAt).toISOString(),
      measurement: "aggregate",
    };
    if (stored?.measurement !== "aggregate") return optimum;
    if (best.charsPerSecond >= stored.charsPerSecond) return optimum;
    if (state.seedPointKey !== undefined && state.measuredPointKeys.has(state.seedPointKey)) return optimum;
    return undefined;
  }

  private bestMeasuredPoint(state: EndpointTuneState): MeasuredThroughputPoint | undefined {
    let best: MeasuredThroughputPoint | undefined;
    for (const point of state.measuredPoints.values()) {
      if (!best || point.charsPerSecond > best.charsPerSecond) best = point;
    }
    return best;
  }

  /**
   * Record one complete, trusted aggregate window at the target size. The first
   * measurement after the size climb restarted opens a new episode: points of
   * the previous one described a server that may since have drifted.
   */
  private recordMeasuredPoint(state: EndpointTuneState, concurrency: number, charsPerSecond: number): void {
    if (state.measuredPointsStale) {
      state.measuredPoints.clear();
      state.measuredPointsStale = false;
    }
    const key = throughputPointKey(state.target, concurrency);
    state.measuredPoints.set(key, { batchSize: state.target, concurrency, charsPerSecond, measuredAt: this.now() });
    state.measuredPointKeys.add(key);
  }

  /**
   * A producer-starved batch or a server failure: every open aggregate window —
   * including the one the probe in force has yet to fill — stops counting as a
   * measurement (the climb still judges it), and the slowdown guard reopens.
   */
  private taintMeasurementWindows(state: EndpointTuneState): void {
    for (const sample of state.concurrencySamples.values()) sample.tainted = true;
    if (state.concurrencyPhase === "climbing" && !state.concurrencySamples.has(state.concurrency)) {
      state.concurrencySamples.set(state.concurrency, { ...emptyConcurrencySample(), tainted: true });
    }
    this.reopenSlowdownGuard(state);
  }

  private reopenSlowdownGuard(state: EndpointTuneState): void {
    state.slowdownGuardSample = emptyConcurrencySample();
    state.slowdownGuardStartedAt = this.now();
  }

  /** Hold the settled point to `charsPerSecond` from now on; a later trip reports `reason`. */
  private armSlowdownGuard(
    state: EndpointTuneState,
    charsPerSecond: number,
    reason: EndpointTuneState["slowdownGuardReason"],
  ): void {
    state.slowdownGuardCharsPerSecond = charsPerSecond;
    state.slowdownGuardReason = reason;
    this.reopenSlowdownGuard(state);
  }

  /**
   * Measure the settled point with the climb's own window (samplesPerSize ×
   * concurrency full batches, aggregate chars/s). A starved window is not
   * judged. Below SETTLED_THROUGHPUT_SLOWDOWN_SHARE of the reference the run
   * drops into the full climb, and the window is kept as a measured point — the
   * evidence that the point got slower. A passing window is no new optimum and
   * is not recorded, so a run that only rode a trusted seed writes nothing.
   */
  private guardSettledPoint(
    state: EndpointTuneState,
    observation: EmbeddingBatchObservation,
    referenceCharsPerSecond: number,
  ): void {
    if (this.isProducerStarved(state)) {
      this.reopenSlowdownGuard(state);
      return;
    }
    const window = state.slowdownGuardSample;
    if (!this.addToWindow(window, observation, state.target, state.slowdownGuardStartedAt)) return;
    if (window.count < this.samplesPerSize * state.concurrency) return;
    const charsPerSecond = this.windowRate(window);
    this.reopenSlowdownGuard(state);
    if (charsPerSecond === undefined) return;
    if (charsPerSecond >= referenceCharsPerSecond * SETTLED_THROUGHPUT_SLOWDOWN_SHARE) return;
    this.recordMeasuredPoint(state, state.concurrency, charsPerSecond);
    this.dropIntoFullClimb(state, charsPerSecond);
  }

  /** The settled point got slower: log it and restart the full ×½ / ×2 climb from the working size. */
  private dropIntoFullClimb(state: EndpointTuneState, charsPerSecond: number): void {
    const reason = state.slowdownGuardReason;
    this.emit(state, { kind: "batchSize", from: state.target, to: state.target, reason, charsPerSecond });
    state.samples.clear();
    this.continueClimb(state, reason);
  }

  /**
   * The periodic re-probe, UPWARD only: size ×2 below the cap first, else
   * straight to concurrency ×2 below the ceiling. At both ceilings it does
   * nothing but restart the count — no adaptation, no samples dropped.
   */
  private startUpwardReprobe(state: EndpointTuneState): void {
    state.batchesSinceSettle = 0;
    const sizeCanRise = Math.min(state.working * 2, state.cap) > state.working;
    const concurrencyCanRise = Math.min(state.concurrencyWorking * 2, this.maxConcurrency) > state.concurrencyWorking;
    if (!sizeCanRise && !concurrencyCanRise) return;
    state.upwardReprobe = true;
    state.upwardReprobeStartSize = state.working;
    state.upwardReprobeReferenceCharsPerSecond = state.slowdownGuardCharsPerSecond;
    if (sizeCanRise) {
      state.samples.clear();
      this.continueClimb(state, "reprobe");
      return;
    }
    this.abandonConcurrencyClimb(state, "reprobe");
    state.concurrencyPhase = "climbing";
    this.continueConcurrencyClimb(state);
  }

  /** Add a full batch at `size` started at or after `openedAt` to `window`; false when it does not count. */
  private addToWindow(
    window: ConcurrencySample,
    observation: EmbeddingBatchObservation,
    size: number,
    openedAt: number,
  ): boolean {
    if (observation.size !== size || observation.durationMs <= 0) return false;
    const startedAt = observation.startedAt ?? this.now() - observation.durationMs;
    if (startedAt < openedAt) return false;
    window.chars += observation.inputChars;
    window.count++;
    window.firstStart = Math.min(window.firstStart, startedAt);
    window.lastEnd = Math.max(window.lastEnd, startedAt + observation.durationMs);
    return true;
  }

  private windowRate(window: ConcurrencySample): number | undefined {
    const spanMs = window.lastEnd - window.firstStart;
    return spanMs > 0 ? (window.chars / spanMs) * 1000 : undefined;
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

  private get maxConcurrency(): number {
    return Math.max(1, this.config.configuredConcurrency);
  }

  private get initialConcurrency(): number {
    const initial = this.config.initialConcurrency ?? this.config.configuredConcurrency;
    return Math.min(this.maxConcurrency, Math.max(1, Math.round(initial)));
  }

  private startConcurrency(endpoint: EmbeddingEndpointIdentity, stored?: EmbeddingThroughputOptimum): number {
    const seeded = this.config.seedConcurrency?.(endpoint) ?? stored?.concurrency;
    if (seeded === undefined || !(seeded > 0)) return this.initialConcurrency;
    return Math.min(this.maxConcurrency, Math.max(1, Math.round(seeded)));
  }

  /**
   * Make `endpoint` the active one, creating its state (seeded from the stored
   * optimum) on first sight. A change of endpoint resumes that endpoint's own
   * batch size and concurrency — a failover never inherits the other server's
   * curve.
   */
  private switchTo(endpoint: EmbeddingEndpointIdentity): EndpointTuneState {
    const key = endpointKey(endpoint);
    const previous = this.active;
    if (previous && endpointKey(previous.endpoint) === key) return previous;

    let state = this.states.get(key);
    if (!state) {
      const stored = this.config.storedOptimum?.(endpoint);
      const seeded = this.config.seed?.(endpoint) ?? stored?.batchSize;
      const start = seeded !== undefined && seeded > 0 ? this.clamp(seeded) : this.ceiling;
      const concurrency = this.startConcurrency(endpoint, stored);
      // An aggregate record is a measured point: the run starts settled at it
      // and only guards it. A per-batch record never measured its concurrency,
      // so it seeds the climb instead.
      const trusted = stored?.measurement === "aggregate" && stored.charsPerSecond > 0 ? stored : undefined;
      state = {
        endpoint: { ...endpoint },
        working: start,
        cap: this.ceiling,
        target: start,
        settled: trusted !== undefined,
        samples: new Map(),
        successStreak: 0,
        batchesSinceSettle: 0,
        concurrency,
        concurrencyWorking: concurrency,
        concurrencyPhase: trusted !== undefined ? "settled" : "idle",
        concurrencySamples: new Map(),
        concurrencyProbeStartedAt: 0,
        starvationWindow: [],
        concurrencyHeldForStarvation: false,
        ...(stored !== undefined
          ? { storedOptimum: { ...stored }, seedPointKey: throughputPointKey(start, concurrency) }
          : {}),
        measuredPoints: new Map(),
        measuredPointsStale: false,
        measuredPointKeys: new Set(),
        ...(trusted !== undefined ? { slowdownGuardCharsPerSecond: trusted.charsPerSecond } : {}),
        slowdownGuardReason: "seed-slower",
        slowdownGuardSample: emptyConcurrencySample(),
        slowdownGuardStartedAt: this.now(),
        upwardReprobe: false,
        upwardReprobeStartSize: start,
      };
      this.states.set(key, state);
    }
    this.active = state;

    const fromSize = previous ? previous.target : this.ceiling;
    const fromConcurrency = previous ? previous.concurrency : this.initialConcurrency;
    if (state.target !== fromSize) {
      this.emit(state, { kind: "batchSize", from: fromSize, to: state.target, reason: "seed" });
    }
    if (state.concurrency !== fromConcurrency) {
      this.emit(state, { kind: "concurrency", from: fromConcurrency, to: state.concurrency, reason: "seed" });
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
    if (state.upwardReprobe) return out;
    const down = Math.max(Math.floor(size / 2), this.floor);
    if (down < size) out.push(down);
    return out;
  }

  /**
   * Decide what to measure next, or settle. Measures `working` first, then each
   * unmeasured neighbour; once all are known, moves to a neighbour that beats
   * `working` by `minImprovement` and repeats from there. Every move strictly
   * raises the measured rate, so the loop terminates. A recovery or a slowdown
   * ends an upward re-probe: both need the full search.
   */
  private continueClimb(
    state: EndpointTuneState,
    reason: "probe" | "reprobe" | "recovery" | "seed-slower" | "settled-slower",
  ): void {
    if (reason !== "probe" && reason !== "reprobe") state.upwardReprobe = false;
    state.settled = false;
    this.abandonConcurrencyClimb(state, reason);
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
      concurrency: state.concurrencyWorking,
      charsPerSecond,
      settledAt: new Date(this.now()).toISOString(),
    };
    this.emit(state, { kind: "batchSize", from, to: state.working, reason: "settle", charsPerSecond });
    // An upward re-probe that moved the size hands concurrency back to the full
    // climb — the old concurrency optimum was measured at another size.
    if (state.upwardReprobe && state.working !== state.upwardReprobeStartSize) state.upwardReprobe = false;
    // The size is fixed now — climb concurrency at it.
    state.concurrencyPhase = "climbing";
    state.concurrencySamples.clear();
    this.continueConcurrencyClimb(state);
  }

  /**
   * Leave the concurrency climb: the size is moving again, so every aggregate
   * sample (measured at the old size) is void. Concurrency returns to the
   * working value; the climb restarts when the size next settles.
   */
  private abandonConcurrencyClimb(state: EndpointTuneState, reason: EmbeddingThroughputAdaptationReason): void {
    // Nothing is settled any more: the guard disarms until the next settle, and
    // the next measurement opens a new episode of measured points.
    state.slowdownGuardCharsPerSecond = undefined;
    state.measuredPointsStale = true;
    state.concurrencyPhase = "idle";
    state.concurrencySamples.clear();
    state.concurrencyHeldForStarvation = false;
    if (state.concurrency === state.concurrencyWorking) return;
    const from = state.concurrency;
    state.concurrency = state.concurrencyWorking;
    this.emit(state, { kind: "concurrency", from, to: state.concurrency, reason });
  }

  /** Remember whether this batch was producer-starved; a batch the caller could not judge is not counted. */
  private recordStarvation(state: EndpointTuneState, observation: EmbeddingBatchObservation): void {
    if (observation.producerStarved === undefined) return;
    state.starvationWindow.push(observation.producerStarved);
    if (state.starvationWindow.length > PRODUCER_STARVATION_WINDOW) state.starvationWindow.shift();
  }

  /**
   * Whether the embed stage is waiting on the chunk producer: at least
   * `samplesPerSize` judged batches, and `PRODUCER_STARVED_BATCH_SHARE` of the
   * window starved.
   */
  private isProducerStarved(state: EndpointTuneState): boolean {
    const window = state.starvationWindow;
    if (window.length < this.samplesPerSize) return false;
    const starved = window.filter(Boolean).length;
    return starved / window.length >= PRODUCER_STARVED_BATCH_SHARE;
  }

  /**
   * Hold the concurrency climb while the producer cannot keep the slots busy
   * (bd tea-rags-mcp-y1ynz). More concurrency would buy nothing, and the
   * aggregate chars/s of a starved window measures the producer's gaps, not the
   * server: judged on it, the climb would wander or settle LOW and the stored
   * optimum would carry that down. So a probe in flight returns to the working
   * value, its samples are dropped, and nothing settles until the producer
   * catches up. Logged once per hold.
   */
  private holdConcurrencyClimbForStarvation(state: EndpointTuneState): void {
    if (state.concurrencyHeldForStarvation) return;
    state.concurrencyHeldForStarvation = true;
    state.concurrencySamples.clear();
    const from = state.concurrency;
    state.concurrency = state.concurrencyWorking;
    this.emit(state, { kind: "concurrency", from, to: state.concurrency, reason: "producer-starved" });
  }

  /** The producer caught up: reopen the climb with a fresh window, batches from the hold excluded. */
  private releaseStarvationHold(state: EndpointTuneState): void {
    if (!state.concurrencyHeldForStarvation) return;
    state.concurrencyHeldForStarvation = false;
    state.concurrencySamples.clear();
    state.concurrencyProbeStartedAt = this.now();
  }

  /**
   * Count one observation toward the concurrency under probe. Only full batches
   * at the settled size count, and only those that started once the probe was
   * open — an earlier one ran under the previous concurrency.
   */
  private sampleConcurrency(state: EndpointTuneState, observation: EmbeddingBatchObservation): void {
    const sample = state.concurrencySamples.get(state.concurrency) ?? emptyConcurrencySample();
    if (!this.addToWindow(sample, observation, state.target, state.concurrencyProbeStartedAt)) return;
    state.concurrencySamples.set(state.concurrency, sample);
    if (sample.count < this.samplesPerSize * state.concurrency) return;
    // A complete window: a measured point unless something untrustworthy rode in it.
    const charsPerSecond = this.aggregateRate(state, state.concurrency);
    if (charsPerSecond !== undefined && !sample.tainted) {
      this.recordMeasuredPoint(state, state.concurrency, charsPerSecond);
      // An upward re-probe re-measures the working point first. Measured slower
      // than the guard's reference, it is a slowdown — the full climb's job.
      const reference = state.upwardReprobeReferenceCharsPerSecond;
      if (
        state.upwardReprobe &&
        state.concurrency === state.concurrencyWorking &&
        reference !== undefined &&
        charsPerSecond < reference * SETTLED_THROUGHPUT_SLOWDOWN_SHARE
      ) {
        this.dropIntoFullClimb(state, charsPerSecond);
        return;
      }
    }
    this.continueConcurrencyClimb(state);
  }

  /** Aggregate chars/s at `concurrency`: total input over the window's wall-clock span. */
  private aggregateRate(state: EndpointTuneState, concurrency: number): number | undefined {
    const sample = state.concurrencySamples.get(concurrency);
    if (!sample || sample.count < this.samplesPerSize * concurrency) return undefined;
    return this.windowRate(sample);
  }

  private concurrencyNeighbours(state: EndpointTuneState, concurrency: number): number[] {
    const out: number[] = [];
    const up = Math.min(concurrency * 2, this.maxConcurrency);
    if (up > concurrency) out.push(up);
    if (state.upwardReprobe) return out;
    const down = Math.max(Math.floor(concurrency / 2), 1);
    if (down < concurrency) out.push(down);
    return out;
  }

  /** `continueClimb` for concurrency, judged on aggregate chars/s. */
  private continueConcurrencyClimb(state: EndpointTuneState): void {
    for (;;) {
      const workingRate = this.aggregateRate(state, state.concurrencyWorking);
      if (workingRate === undefined) {
        this.probeConcurrency(state, state.concurrencyWorking);
        return;
      }
      const neighbours = this.concurrencyNeighbours(state, state.concurrencyWorking);
      const unmeasured = neighbours.find((c) => this.aggregateRate(state, c) === undefined);
      if (unmeasured !== undefined) {
        this.probeConcurrency(state, unmeasured);
        return;
      }
      let best = state.concurrencyWorking;
      let bestRate = workingRate;
      for (const c of neighbours) {
        const r = this.aggregateRate(state, c) ?? 0;
        if (r > bestRate) {
          best = c;
          bestRate = r;
        }
      }
      if (best !== state.concurrencyWorking && bestRate > workingRate * (1 + this.minImprovement)) {
        state.concurrencyWorking = best;
        continue;
      }
      this.settleConcurrency(state, workingRate);
      return;
    }
  }

  /** Open a probe window at `concurrency`; batches started before now do not count toward it. */
  private probeConcurrency(state: EndpointTuneState, concurrency: number): void {
    state.concurrencyProbeStartedAt = this.now();
    if (state.concurrency === concurrency) return;
    const from = state.concurrency;
    state.concurrency = concurrency;
    this.emit(state, {
      kind: "concurrency",
      from,
      to: concurrency,
      reason: "concurrency-probe",
      charsPerSecond: this.aggregateRate(state, from),
    });
  }

  private settleConcurrency(state: EndpointTuneState, charsPerSecond: number): void {
    const from = state.concurrency;
    state.concurrency = state.concurrencyWorking;
    state.concurrencyPhase = "settled";
    state.upwardReprobe = false;
    this.armSlowdownGuard(state, charsPerSecond, "settled-slower");
    if (state.optimum) {
      state.optimum = {
        ...state.optimum,
        concurrency: state.concurrencyWorking,
        settledAt: new Date(this.now()).toISOString(),
      };
    }
    this.emit(state, {
      kind: "concurrency",
      from,
      to: state.concurrencyWorking,
      reason: "concurrency-settle",
      charsPerSecond,
    });
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
    state.upwardReprobe = false;
    state.cap = newCap;
    this.abandonConcurrencyClimb(state, "failure");
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
