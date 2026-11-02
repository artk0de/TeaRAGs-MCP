/**
 * LlamaServerEmbeddings — `EMBEDDING_PROVIDER=llama-server`.
 *
 * Built for a REMOTE GPU host running one llama-server per GPU. Each pipeline
 * batch is cut into char-balanced micro-batches on one shared queue, and every
 * healthy endpoint of the active tier (peers, or the local fallback
 * llama-server once every peer has failed) runs one worker per `/props`
 * `total_slots` slot that pulls the next micro-batch until the queue is empty
 * — work stealing, so a fast GPU takes more micro-batches, a slow one fewer,
 * and every `-np` slot stays busy without the pipeline raising its own
 * concurrency.
 *
 * The slot cap holds ACROSS calls: the pipeline runs several embedBatch calls
 * at once, and every request of every call first takes a lease of its
 * endpoint from one `EmbeddingEndpointSlotLimiter` per provider, `total_slots`
 * wide, handed out first come, first served. A worker pulls its next
 * micro-batch only once it holds a lease, so an endpoint whose slots are all
 * busy leaves the queue to the endpoints that are free. At most `total_slots`
 * requests per endpoint are on the wire, and the request timeout is armed only
 * once the lease is held, so it measures server time, never client-side
 * queueing — a slow-but-alive GPU does not time out requests still waiting
 * for one of its slots.
 *
 * Failure classes, decided per request:
 * - ENDPOINT failure (refused, timeout, 5xx unrelated to size, malformed body):
 *   recorded on the pool, the micro-batch goes back to the FRONT of the queue,
 *   and that endpoint stops pulling; the endpoints still standing drain it, in
 *   the same call. The caller sees an error only
 *   when no endpoint is left and the recovery wait
 *   (`unavailableRetryMaxWaitMs`) has run out.
 * - SIZE failure (an HTTP 400/500 whose body says the input is too large, or a
 *   socket reset on a multi-text request): retried in halves on the same
 *   endpoint, reported to `observeServerBatchFailures` observers. Never marks
 *   the endpoint failed. A single text that fails on size is a context overflow.
 * - CALLER failure (any other 4xx — bad request, wrong API key): propagates.
 *
 * Every endpoint's `/props` `model_path` is checked against EMBEDDING_MODEL the
 * first time it is read. An endpoint serving another model is retired from the
 * pool and never receives an embedding request; when no endpoint serving the
 * model is left, the call fails with `LlamaServerModelMismatchError` without a
 * recovery wait.
 */

import {
  effectiveRecoveryWaitMs,
  type EmbeddingCallOptions,
  type EmbeddingEndpointFailure,
  type EmbeddingProvider,
  type EmbeddingResult,
  type EmbeddingServerBatchFailure,
  type RateLimitConfig,
} from "../base.js";
import { planEmbeddingMicroBatches } from "../batch-fanout.js";
import type { EmbeddingEndpointDownVerdictStore } from "../endpoint-down-verdicts.js";
import { EmbeddingEndpointPool, parseEmbeddingEndpointList } from "../endpoint-pool.js";
import { EmbeddingEndpointSlotLimiter } from "../endpoint-slot-limiter.js";
import { describeConnectFailure, isConnectClassFailure, isTimeoutAbort } from "../utils/connect-failure.js";
import { getModelDimensions, resolveStartingDimensions } from "../utils/model-dimensions.js";
import {
  LlamaServerContextOverflowError,
  LlamaServerModelMismatchError,
  LlamaServerProbeError,
  LlamaServerResponseError,
  LlamaServerUnavailableError,
  type LlamaServerServedModel,
} from "./errors.js";
import { fetchLlamaServerProps, type LlamaServerProps } from "./props.js";

/** llama-server's default port. */
export const LLAMA_SERVER_DEFAULT_URL = "http://localhost:8080";

/**
 * How long after a SUCCESSFUL managed-pool revive the next outage may revive
 * again. A long-lived server outlives more than one pool crash; the window
 * keeps a pool that dies on start from being restarted on every batch.
 */
export const LLAMA_SERVER_REVIVE_REARM_MS = 10 * 60_000;

/**
 * Failback probe cadence. Same value as the Ollama provider's primary probe
 * (`PRIMARY_PROBE_INTERVAL_MS` in ollama.ts, kept private there).
 */
const FAILBACK_PROBE_INTERVAL_MS = 30_000;
const HEALTH_PROBE_TIMEOUT_MS = 3_000;
const FAILOVER_CONSECUTIVE_FAILURES_DEFAULT = 3;
const UNAVAILABLE_RETRY_DEFAULT_BASE_DELAY_MS = 2_000;
const UNAVAILABLE_RETRY_MAX_DELAY_MS = 30_000;
/** Same request budget as the Ollama provider: 30s base + 200ms per text. */
const REQUEST_BASE_TIMEOUT_MS = 30_000;
const REQUEST_PER_TEXT_TIMEOUT_MS = 200;
/** Width assumed before anyone could be asked (jina-v2-base-code, the default model). */
const DEFAULT_DIMENSIONS = 768;

/** Body of an HTTP error that says the input did not fit the server's batch / context. */
const SIZE_FAILURE_BODY = /too large|exceeds|context|n_ubatch|batch size/i;
/** Longest server body a failure cause quotes. */
const FAILURE_BODY_EXCERPT_CHARS = 200;
/** undici codes for a connection the server dropped mid-request. */
const SOCKET_RESET_CODES = new Set(["ECONNRESET", "UND_ERR_SOCKET", "EPIPE"]);

/** Same shape as the Ollama provider's `OllamaRecoveryWaitEvent`, so one CLI listener serves both. */
export type LlamaServerRecoveryWaitEvent =
  | { state: "waiting"; url: string; elapsedMs: number; budgetMs: number }
  | { state: "recovered"; url: string; elapsedMs: number };

export interface LlamaServerEmbeddingsDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  /** Operator-facing lines (model check, size failures). Default: stderr. */
  log?: (line: string) => void;
  /**
   * Cross-process "endpoint down" verdicts (bd w1bz7). Read once at
   * construction, written on connect-class failures. Absent → every process
   * discovers a dead endpoint on its own.
   */
  endpointDownVerdicts?: EmbeddingEndpointDownVerdictStore;
  /** Deadline signal of one embeddings request, armed once its slot lease is held. Default: `AbortSignal.timeout`. */
  requestTimeoutSignal?: (ms: number) => AbortSignal;
  /**
   * Bring the configured peer endpoints back when none answers (a managed pool
   * after a reboot, bd hjbow.6). Called at most once per provider: `true` → the
   * call re-probes and retries; `false` or a throw → the outage takes its usual
   * course. Absent → no revive.
   */
  reviveEndpoints?: (endpoints: string[]) => Promise<boolean>;
}

interface LlamaServerEmbeddingsResponse {
  data?: { index?: number; embedding?: number[] }[];
}

/** The endpoint failed the request; its texts go elsewhere. Never leaves the provider. */
class EndpointRequestFailure extends Error {
  constructor(
    readonly url: string,
    readonly kind: "refused" | "transient",
    readonly reason: unknown,
    /** How long the request ran on the wire before it failed; undefined when none was sent. */
    readonly elapsedMs?: number,
  ) {
    super(`llama-server endpoint ${url} failed (${kind}): ${describe(reason)}`);
  }
}

/**
 * Endpoints one call stopped using because they failed it. A passing `/health`
 * does not lift an exclusion: an endpoint can be live and still fail every
 * request (5xx, 429, a malformed body), and retrying it on that evidence spins
 * the call without ever reaching the fallback (bd hgghf). Exclusions lift once
 * the call has backed off. The one exception is an endpoint the call could not
 * REACH — a probe that reaches it contradicts exactly that evidence, so a
 * probe lifts it, once per endpoint per call.
 */
class EndpointCallExclusions {
  readonly urls = new Set<string>();
  private readonly unreachable = new Set<string>();
  private readonly liftedByProbe = new Set<string>();

  exclude(failure: EndpointRequestFailure): void {
    this.urls.add(failure.url);
    if (isConnectClassFailure(failure.reason)) this.unreachable.add(failure.url);
    else this.unreachable.delete(failure.url);
  }

  /** Lift the exclusion of each unreachable endpoint a probe has since found live. */
  liftReachable(isLive: (url: string) => boolean): void {
    for (const url of this.unreachable) {
      if (this.liftedByProbe.has(url) || !isLive(url)) continue;
      this.liftedByProbe.add(url);
      this.unreachable.delete(url);
      this.urls.delete(url);
    }
  }

  /** The call has backed off: every endpoint gets another chance. */
  clear(): void {
    this.urls.clear();
    this.unreachable.clear();
  }
}

/** The server failed the request on its SIZE; halve it. Never leaves the provider. */
class BatchSizeFailure extends Error {
  constructor(
    readonly url: string,
    readonly status: number | undefined,
    readonly body: string,
    /** What the server answered, as `EmbeddingServerBatchFailure#cause` reports it. */
    readonly serverCause: string,
  ) {
    super(`llama-server at ${url} failed a batch on size: ${body}`);
  }
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function bodyExcerpt(body: string): string {
  return body.slice(0, FAILURE_BODY_EXCERPT_CHARS);
}

/** An endpoint failure's reason as an observer reads it: the HTTP line as is, an error by its errno / timeout / message. */
function describeEndpointFailureReason(reason: unknown): string {
  return typeof reason === "string" ? reason : describeConnectFailure(reason);
}

/** Message of the innermost `cause` — undici wraps the socket error in a generic "fetch failed". */
function innermostErrorMessage(error: unknown): string {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  return describe(current);
}

function isLlamaServerHealthBody(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && typeof (parsed as { status?: unknown }).status === "string";
  } catch {
    return false;
  }
}

function portOf(url: string): string {
  const parsed = new URL(url);
  return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
}

function errorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = cause?.code ?? (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Recovery-wait bookkeeping for one embed call. */
interface RecoveryWaitState {
  start: number;
  /** This call's budget: the configured one, narrowed by `EmbeddingCallOptions#maxRecoveryWaitMs`. */
  budgetMs: number;
  attempt: number;
  lastError?: Error;
}

export class LlamaServerEmbeddings implements EmbeddingProvider {
  private readonly model: string;
  private dimensions: number;
  private readonly dimensionsPinned: boolean;
  private readonly apiKey?: string;
  private readonly pool: EmbeddingEndpointPool;
  private readonly unavailableRetryMaxWaitMs: number;
  private readonly unavailableRetryBaseDelayMs: number;

  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly startInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly stopInterval: (timer: ReturnType<typeof setInterval>) => void;
  private readonly log: (line: string) => void;
  private readonly downVerdicts?: EmbeddingEndpointDownVerdictStore;
  /** Endpoints this process knows carry a down verdict; a success on one withdraws it. */
  private readonly downVerdictUrls = new Set<string>();

  private probeTimer?: ReturnType<typeof setInterval>;
  /** `/props` per endpoint; dropped when the endpoint fails (it may come back with another `-np`). */
  private readonly propsCache = new Map<string, Promise<LlamaServerProps | undefined>>();
  /** Endpoints found serving another model, by URL → the GGUF they loaded. Never cleared. */
  private readonly servedModelMismatches = new Map<string, string>();
  /** Endpoints whose `/props` `model_path` has been judged already. */
  private readonly servedModelChecked = new Set<string>();
  private cachedModelInfo?: { model: string; contextLength: number; dimensions: number };
  private modelInfoInFlight?: Promise<{ model: string; contextLength: number; dimensions: number } | undefined>;
  private readonly serverBatchFailureObservers = new Set<(event: EmbeddingServerBatchFailure) => void>();
  private readonly endpointFailureObservers = new Set<(event: EmbeddingEndpointFailure) => void>();
  /** Slot leases per endpoint, shared by every concurrent call of this provider. */
  private readonly slotLimiter = new EmbeddingEndpointSlotLimiter();
  private readonly requestTimeoutSignal: (ms: number) => AbortSignal;
  private readonly reviveEndpoints?: (endpoints: string[]) => Promise<boolean>;
  /** The revive in flight; every call blocked on the outage shares it. Cleared once it settles. */
  private reviveInFlight?: Promise<boolean>;
  /**
   * No revive starts before this instant: a successful one blocks for
   * {@link LLAMA_SERVER_REVIVE_REARM_MS}, a failed one for good.
   */
  private reviveBlockedUntil = Number.NEGATIVE_INFINITY;

  /** Connection-recovery wait visibility for the CLI (same contract as the Ollama provider's). */
  onRecoveryWait?: (event: LlamaServerRecoveryWaitEvent) => void;

  constructor(
    model: string,
    dimensions: number | undefined,
    rateLimit: RateLimitConfig,
    baseUrls: string,
    fallbackUrls?: string,
    apiKey?: string,
    deps: LlamaServerEmbeddingsDeps = {},
  ) {
    this.model = model;
    this.dimensionsPinned = dimensions !== undefined && dimensions > 0;
    this.dimensions = resolveStartingDimensions(model, dimensions, DEFAULT_DIMENSIONS);
    this.apiKey = apiKey && apiKey.length > 0 ? apiKey : undefined;
    this.unavailableRetryMaxWaitMs = rateLimit.unavailableRetryMaxWaitMs ?? 0;
    this.unavailableRetryBaseDelayMs = rateLimit.unavailableRetryBaseDelayMs || UNAVAILABLE_RETRY_DEFAULT_BASE_DELAY_MS;

    this.fetchFn = deps.fetch ?? (async (input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.requestTimeoutSignal = deps.requestTimeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
    this.sleep = deps.sleep ?? (async (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.startInterval = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.stopInterval =
      deps.clearInterval ??
      ((timer) => {
        clearInterval(timer);
      });
    this.log =
      deps.log ??
      ((line) => {
        console.error(line);
      });

    const peers = parseEmbeddingEndpointList(baseUrls);
    this.pool = new EmbeddingEndpointPool({
      peers: peers.length > 0 ? peers : [LLAMA_SERVER_DEFAULT_URL],
      fallbacks: parseEmbeddingEndpointList(fallbackUrls),
      failoverConsecutiveFailures: rateLimit.failoverConsecutiveFailures ?? FAILOVER_CONSECUTIVE_FAILURES_DEFAULT,
      probeIntervalMs: FAILBACK_PROBE_INTERVAL_MS,
      probe: async (url) => this.probeHealth(url),
      now: this.now,
    });
    this.downVerdicts = deps.endpointDownVerdicts;
    this.reviveEndpoints = deps.reviveEndpoints;
    this.adoptDownVerdicts();
  }

  // ---------------------------------------------------------------------------
  // EmbeddingProvider
  // ---------------------------------------------------------------------------

  async embed(text: string, options?: EmbeddingCallOptions): Promise<EmbeddingResult> {
    const [result] = await this.embedBatch([text], options);
    return result;
  }

  async embedBatch(texts: string[], options?: EmbeddingCallOptions): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];
    const vectors = new Array<number[] | undefined>(texts.length);
    await this.embedAcrossEndpoints(
      texts,
      texts.map((_, i) => i),
      vectors,
      effectiveRecoveryWaitMs(this.unavailableRetryMaxWaitMs, options),
    );
    return vectors.map((embedding) => {
      const vector = embedding ?? [];
      return { embedding: vector, dimensions: vector.length };
    });
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }

  getProviderName(): string {
    return "llama-server";
  }

  /** The endpoint serving right now — the throughput tuner keys its optimum on it. */
  getBaseUrl(): string {
    return this.pool.primaryUrl();
  }

  /** The configured peer list, comma-joined. */
  getPrimaryBaseUrl(): string {
    return this.pool.configuredPeersLabel();
  }

  getFallbackBaseUrl(): string | undefined {
    return this.pool.configuredFallbacksLabel();
  }

  /**
   * The configured TIER a batch fans out over — every peer, or every fallback
   * once the peers are down — never one member: the batch shape the tuner
   * measures belongs to the set (bd tea-rags-mcp-y1ynz).
   */
  getThroughputTuneEndpointUrl(endpointUrl?: string): string {
    return this.pool.configuredTierLabel(endpointUrl);
  }

  async checkHealth(): Promise<boolean> {
    const cached = this.cachedDownReasons();
    const peersUp = await this.pool.checkPeersHealth(cached);
    const healthy = peersUp || (await this.pool.checkFallbacksHealth(cached)) === true;
    this.syncProbeTimer();
    return healthy;
  }

  async checkPrimaryHealth(): Promise<boolean> {
    const up = await this.pool.checkPeersHealth(this.cachedDownReasons());
    this.syncProbeTimer();
    return up;
  }

  async checkFallbackHealth(): Promise<boolean | undefined> {
    const up = await this.pool.checkFallbacksHealth(this.cachedDownReasons());
    this.syncProbeTimer();
    return up;
  }

  observeServerBatchFailures(observer: (event: EmbeddingServerBatchFailure) => void): () => void {
    this.serverBatchFailureObservers.add(observer);
    return () => {
      this.serverBatchFailureObservers.delete(observer);
    };
  }

  observeEndpointFailures(observer: (event: EmbeddingEndpointFailure) => void): () => void {
    this.endpointFailureObservers.add(observer);
    return () => {
      this.endpointFailureObservers.delete(observer);
    };
  }

  /**
   * Context length is the per-slot window from `/props`; the width is pinned
   * config, else the dimension registry, else measured from one probe embed.
   * Undefined when `/props` reports no context.
   */
  async resolveModelInfo(): Promise<{ model: string; contextLength: number; dimensions: number } | undefined> {
    if (this.cachedModelInfo) return this.cachedModelInfo;
    if (this.modelInfoInFlight) return this.modelInfoInFlight;
    this.modelInfoInFlight = this.fetchModelInfo().finally(() => {
      this.modelInfoInFlight = undefined;
    });
    return this.modelInfoInFlight;
  }

  // ---------------------------------------------------------------------------
  // Fan-out
  // ---------------------------------------------------------------------------

  /**
   * Embed `indices` of `texts` into `vectors` by work stealing: the texts are
   * planned once into micro-batches on a shared FIFO queue, and every active
   * endpoint drains it with one worker per slot. A micro-batch whose endpoint
   * failed returns to the front of the queue for the endpoints still standing.
   * An endpoint that failed in this call is not asked again until the call has
   * backed off (see `EndpointCallExclusions`). Fallbacks are admitted only
   * after the current call has exhausted its peer endpoints, so a remaining
   * healthy peer always stays ahead of fallback capacity.
   */
  private async embedAcrossEndpoints(
    texts: readonly string[],
    indices: number[],
    vectors: (number[] | undefined)[],
    recoveryBudgetMs: number,
  ): Promise<void> {
    const wait: RecoveryWaitState = { start: this.now(), budgetMs: recoveryBudgetMs, attempt: 0 };
    const exclusions = new EndpointCallExclusions();
    let allowFallback = false;
    let queue: number[][] | undefined;

    while (queue === undefined || queue.length > 0) {
      const active = this.pool.activeEndpoints(exclusions.urls);
      if (allowFallback && active.length === 0 && this.pool.activeTier() === "peer") {
        active.push(...this.pool.activeFallbackEndpoints(exclusions.urls));
      }
      if (active.length === 0) {
        await this.waitForEndpoint(wait, exclusions, allowFallback);
        continue;
      }

      const endpoints = await Promise.all(
        active.map(async (e) => ({
          url: e.url,
          slots: Math.max(1, Math.floor((await this.propsFor(e.url))?.totalSlots ?? 1)),
        })),
      );
      queue ??= planEmbeddingMicroBatches(
        indices.map((i) => texts[i]),
        endpoints.reduce((sum, e) => sum + e.slots, 0),
      ).map((microBatch) => microBatch.map((k) => indices[k]));

      const round = await this.drainMicroBatchQueue(queue, endpoints, texts, vectors);
      for (const failure of round.endpointFailures) {
        this.noteEndpointFailure(failure);
        exclusions.exclude(failure);
        allowFallback = true;
        wait.lastError = failure;
      }
      if (round.callerError !== undefined) throw round.callerError;
      if (round.endpointFailures.length === 0 && wait.attempt > 0) {
        this.onRecoveryWait?.({ state: "recovered", url: this.getBaseUrl(), elapsedMs: this.now() - wait.start });
      }
    }
  }

  /**
   * One drain round: `slots` workers per endpoint pull micro-batches off the
   * front of `queue` until it is empty. A worker takes a lease of its endpoint
   * from the provider-wide slot limiter BEFORE it pulls and holds it for that
   * one micro-batch (its size-failure halves included), so `slots` caps the
   * endpoint across every concurrent call and a saturated endpoint does not
   * hoard queued micro-batches. An endpoint failure puts its micro-batch back
   * at the front and stops that endpoint's workers (their in-flight
   * micro-batches finish or fail on their own); a caller failure stops every
   * worker from pulling more. Workers still waiting for a lease give up once
   * the queue is empty with nothing of this round in flight — nothing can be
   * requeued then. Resolves once all in-flight work has settled; never rejects.
   */
  private async drainMicroBatchQueue(
    queue: number[][],
    endpoints: readonly { url: string; slots: number }[],
    texts: readonly string[],
    vectors: (number[] | undefined)[],
  ): Promise<{ endpointFailures: EndpointRequestFailure[]; callerError?: Error }> {
    const endpointFailures: EndpointRequestFailure[] = [];
    const stopped = new Set<string>();
    const leaseWaits = new Map(endpoints.map((endpoint) => [endpoint.url, new AbortController()]));
    let callerError: Error | undefined;
    let inFlight = 0;

    /** Cancel the lease waits of `url`, or of every endpoint. */
    const stopWaiting = (url?: string): void => {
      for (const [waitUrl, controller] of leaseWaits) if (url === undefined || url === waitUrl) controller.abort();
    };

    const worker = async (url: string, slots: number): Promise<void> => {
      while (!stopped.has(url) && callerError === undefined && queue.length > 0) {
        const release = await this.slotLimiter.acquire(url, slots, leaseWaits.get(url)?.signal);
        if (release === undefined) return;
        try {
          if (stopped.has(url) || callerError !== undefined) return;
          const microBatch = queue.shift();
          if (microBatch === undefined) return;
          inFlight += 1;
          try {
            await this.embedOnEndpoint(url, texts, microBatch, vectors);
          } catch (error) {
            if (error instanceof EndpointRequestFailure) {
              queue.unshift(microBatch);
              endpointFailures.push(error);
              stopped.add(url);
              stopWaiting(url);
            } else {
              callerError ??= error instanceof Error ? error : new Error(describe(error));
              stopWaiting();
            }
            return;
          } finally {
            inFlight -= 1;
            if (queue.length === 0 && inFlight === 0) stopWaiting();
          }
        } finally {
          release();
        }
      }
    };

    await Promise.all(
      endpoints.flatMap((endpoint) =>
        Array.from({ length: endpoint.slots }, async () => worker(endpoint.url, endpoint.slots)),
      ),
    );
    return { endpointFailures, callerError };
  }

  /** Embed `indices` on one endpoint, halving on size failures. */
  private async embedOnEndpoint(
    url: string,
    texts: readonly string[],
    indices: readonly number[],
    vectors: (number[] | undefined)[],
  ): Promise<void> {
    const batch = indices.map((i) => texts[i]);
    try {
      const started = this.now();
      const embeddings = await this.postEmbeddings(url, batch);
      this.pool.recordSuccess(
        url,
        batch.reduce((sum, t) => sum + t.length, 0),
        this.now() - started,
      );
      if (this.downVerdictUrls.has(url)) this.withdrawDownVerdict(url);
      indices.forEach((index, k) => {
        vectors[index] = embeddings[k];
      });
    } catch (error) {
      if (!(error instanceof BatchSizeFailure)) throw error;
      if (indices.length <= 1) {
        throw new LlamaServerContextOverflowError(url, error.status ?? 500, error.body);
      }
      const half = Math.ceil(indices.length / 2);
      this.log(`[llama-server] ${url} failed a ${indices.length}-text batch on size; retrying in batches of ${half}`);
      const event: EmbeddingServerBatchFailure = {
        failedSize: indices.length,
        retrySize: half,
        endpointUrl: url,
        cause: error.serverCause,
      };
      for (const observer of this.serverBatchFailureObservers) observer(event);
      // Still under the caller's slot lease: the halves never wait for another slot.
      await this.embedOnEndpoint(url, texts, indices.slice(0, half), vectors);
      await this.embedOnEndpoint(url, texts, indices.slice(half), vectors);
    }
  }

  /** One `POST /v1/embeddings`; classifies every failure into the three classes. */
  private async postEmbeddings(url: string, batch: string[]): Promise<number[][]> {
    // Retired as it was judged, possibly after this request's split was made.
    if (this.servedModelMismatches.has(url)) {
      throw new EndpointRequestFailure(url, "transient", `serves ${this.servedModelMismatches.get(url)}`);
    }
    let response: Response;
    const sentAt = this.now();
    const elapsedMs = (): number => this.now() - sentAt;
    try {
      response = await this.fetchFn(`${url}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({ input: batch, model: this.model }),
        // Armed here, under the caller's slot lease: the deadline counts server time only.
        signal: this.requestTimeoutSignal(REQUEST_BASE_TIMEOUT_MS + batch.length * REQUEST_PER_TEXT_TIMEOUT_MS),
      });
    } catch (error) {
      const code = errorCode(error);
      if (code === "ECONNREFUSED") throw new EndpointRequestFailure(url, "refused", error, elapsedMs());
      if (code !== undefined && SOCKET_RESET_CODES.has(code) && batch.length > 1) {
        throw new BatchSizeFailure(url, undefined, describe(error), `${code}: ${innermostErrorMessage(error)}`);
      }
      throw new EndpointRequestFailure(url, "transient", error, elapsedMs());
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const httpCause = `HTTP ${response.status}: ${bodyExcerpt(body)}`;
      if ((response.status === 400 || response.status === 500) && SIZE_FAILURE_BODY.test(body)) {
        throw new BatchSizeFailure(url, response.status, body, httpCause);
      }
      if (response.status >= 500 || response.status === 429) {
        throw new EndpointRequestFailure(url, "transient", httpCause, elapsedMs());
      }
      throw new LlamaServerResponseError(url, response.status, body);
    }

    let parsed: LlamaServerEmbeddingsResponse;
    try {
      parsed = (await response.json()) as LlamaServerEmbeddingsResponse;
    } catch (error) {
      throw new EndpointRequestFailure(url, "transient", error, elapsedMs());
    }
    const data = parsed.data ?? [];
    const embeddings = new Array<number[] | undefined>(batch.length);
    data.forEach((item, position) => {
      const index = typeof item.index === "number" ? item.index : position;
      if (index >= 0 && index < batch.length && Array.isArray(item.embedding)) embeddings[index] = item.embedding;
    });
    if (data.length !== batch.length || embeddings.some((e) => e === undefined)) {
      throw new EndpointRequestFailure(
        url,
        "transient",
        `malformed response: expected ${batch.length} vectors, got ${data.length}`,
        elapsedMs(),
      );
    }
    return embeddings as number[][];
  }

  // ---------------------------------------------------------------------------
  // Health, failback and recovery wait
  // ---------------------------------------------------------------------------

  private noteEndpointFailure(failure: EndpointRequestFailure): void {
    const event: EmbeddingEndpointFailure = {
      endpointUrl: failure.url,
      kind: failure.kind,
      reason: describeEndpointFailureReason(failure.reason),
      ...(failure.elapsedMs === undefined ? {} : { elapsedMs: failure.elapsedMs }),
    };
    for (const observer of this.endpointFailureObservers) observer(event);
    if (isConnectClassFailure(failure.reason)) this.recordDownVerdict(failure.url, failure.reason);
    this.pool.recordEndpointFailure(failure.url, failure.kind);
    this.propsCache.delete(failure.url);
    this.syncProbeTimer();
  }

  /**
   * No endpoint is usable by this call. Probe every endpoint directly (the
   * pool's own interval gate is for the background timer, not for a caller
   * that is already blocked); return at once if that brings back an endpoint
   * the call may use, else back off until the call's budget is spent and give
   * every excluded endpoint another chance. A zero budget still makes that one
   * direct probe: an endpoint that is back answers.
   */
  private async waitForEndpoint(
    wait: RecoveryWaitState,
    exclusions: EndpointCallExclusions,
    allowFallback: boolean,
  ): Promise<void> {
    this.failWhenNoEndpointServesModel();
    await this.reprobeAll();
    exclusions.liftReachable((url) => this.pool.snapshot().some((e) => e.url === url && e.healthy));
    const active = this.pool.activeEndpoints(exclusions.urls);
    if (allowFallback && this.pool.activeTier() === "peer") {
      active.push(...this.pool.activeFallbackEndpoints(exclusions.urls));
    }
    if (active.length > 0) return;
    if (await this.revivePeers()) {
      exclusions.clear();
      return;
    }
    const remainingMs = wait.start + wait.budgetMs - this.now();
    if (remainingMs <= 0) {
      const recoveryWaitMs = wait.attempt > 0 ? this.now() - wait.start : 0;
      throw new LlamaServerUnavailableError(
        this.pool.configuredPeersLabel(),
        this.pool.configuredFallbacksLabel(),
        wait.lastError,
        recoveryWaitMs,
      );
    }
    const delayMs = Math.min(
      this.unavailableRetryBaseDelayMs * 2 ** wait.attempt,
      UNAVAILABLE_RETRY_MAX_DELAY_MS,
      remainingMs,
    );
    wait.attempt += 1;
    this.onRecoveryWait?.({
      state: "waiting",
      url: this.getBaseUrl(),
      elapsedMs: this.now() - wait.start,
      budgetMs: wait.budgetMs,
    });
    await this.sleep(delayMs);
    await this.reprobeAll();
    exclusions.clear();
  }

  /**
   * Single-flight revive of the configured peers. Calls blocked on the same
   * outage share the attempt in flight; once it settles, a new outage may
   * revive again only after {@link LLAMA_SERVER_REVIVE_REARM_MS} (success) or
   * never (failure), so a pool that keeps dying is not restarted on every
   * batch. `true` only after the revive succeeded and a direct re-probe ran.
   */
  private async revivePeers(): Promise<boolean> {
    if (this.reviveEndpoints === undefined) return false;
    if (this.reviveInFlight === undefined) {
      if (this.now() < this.reviveBlockedUntil) return false;
      const peers = this.pool
        .snapshot()
        .filter((e) => e.tier === "peer")
        .map((e) => e.url);
      this.log(`[llama-server] no endpoint answers at ${peers.join(",")}; restarting its managed pool`);
      const revive = this.reviveEndpoints;
      this.reviveInFlight = (async () => {
        let revived = false;
        try {
          revived = await revive(peers);
          return revived;
        } catch {
          return false;
        } finally {
          this.reviveBlockedUntil = revived ? this.now() + LLAMA_SERVER_REVIVE_REARM_MS : Number.POSITIVE_INFINITY;
          this.reviveInFlight = undefined;
        }
      })();
    }
    if (!(await this.reviveInFlight)) return false;
    await this.reprobeAll();
    return true;
  }

  private async reprobeAll(): Promise<void> {
    if (!(await this.pool.checkPeersHealth())) await this.pool.checkFallbacksHealth();
    this.syncProbeTimer();
  }

  /**
   * Start with the endpoints another process found dead moments ago already
   * failed over, so this process pays neither their `/props` nor their connect
   * timeout. They stay on the failback probe like any failed endpoint. When
   * the verdicts cover EVERY endpoint, none is adopted: with nothing left to
   * fail over to, a stale verdict must not turn into a fast failure.
   */
  private adoptDownVerdicts(): void {
    const verdicts = this.downVerdicts?.liveVerdicts() ?? [];
    for (const verdict of verdicts) this.downVerdictUrls.add(verdict.url);
    const endpoints = this.pool.snapshot();
    const marked = endpoints.filter((e) => this.downVerdictUrls.has(e.url));
    if (marked.length === 0 || marked.length === endpoints.length) return;
    for (const endpoint of marked) this.pool.recordEndpointFailure(endpoint.url, "refused");
    this.syncProbeTimer();
  }

  /** Call only for a connect-class failure (or a `/props` / `/health` timeout) — never an HTTP or model error. */
  private recordDownVerdict(url: string, error: unknown): void {
    if (!this.downVerdicts) return;
    this.downVerdicts.markDown(url, describeConnectFailure(error));
    this.downVerdictUrls.add(url);
  }

  /**
   * Status-probe reasons for the endpoints holding a live down verdict: a
   * status read reports them down from the verdict instead of paying the probe
   * timeout again (bd sm1ow). The embed path never reads this — it probes.
   */
  private cachedDownReasons(): Map<string, string> {
    const now = this.now();
    const reasons = new Map<string, string>();
    for (const verdict of this.downVerdicts?.liveVerdicts() ?? []) {
      const ageSeconds = Math.round((now - verdict.downAt) / 1000);
      reasons.set(
        verdict.url,
        `${verdict.url} is unreachable: ${verdict.reason} (cached verdict, age ${ageSeconds} s)`,
      );
    }
    return reasons;
  }

  private withdrawDownVerdict(url: string): void {
    if (!this.downVerdicts) return;
    this.downVerdicts.clear(url);
    this.downVerdictUrls.delete(url);
  }

  /** Run the failback probe while any endpoint is failed; stop it once all are healthy. */
  private syncProbeTimer(): void {
    const anyFailed = this.pool.snapshot().some((e) => !e.healthy);
    if (anyFailed && !this.probeTimer) {
      const timer = this.startInterval(() => {
        void this.pool.probeFailed().then(() => {
          this.syncProbeTimer();
        });
      }, FAILBACK_PROBE_INTERVAL_MS);
      (timer as { unref?: () => void }).unref?.();
      this.probeTimer = timer;
    } else if (!anyFailed && this.probeTimer) {
      this.stopInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
  }

  /**
   * `/health` of a real llama-server answers `{"status": "ok"}` (200), or 503
   * while the model loads. Any other responder on the port — a 404, a plain
   * "OK" — is a foreign process (bd tea-rags-mcp-1xnmd): it throws a reason
   * naming it instead of passing as healthy.
   */
  private async probeHealth(url: string): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetchFn(`${url}/health`, {
        method: "GET",
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      if (isConnectClassFailure(error) || isTimeoutAbort(error)) this.recordDownVerdict(url, error);
      throw new LlamaServerProbeError(url, `${url} is unreachable: ${describeConnectFailure(error)}`, error);
    }
    const body = await response.text().catch(() => "");
    if (response.status === 503) {
      throw new LlamaServerProbeError(url, `llama-server at ${url} answered 503 on /health (still loading the model?)`);
    }
    if (response.ok && isLlamaServerHealthBody(body)) {
      // Unconditional: another process may have marked it after this one read the verdicts.
      this.withdrawDownVerdict(url);
      return true;
    }
    const seen = `GET ${url}/health answered ${response.status} ${response.headers.get("content-type") ?? "no content-type"} ${JSON.stringify(body.slice(0, 80))}`;
    throw new LlamaServerProbeError(url, `port ${portOf(url)} is held by a non-llama-server process (${seen})`);
  }

  /** Why the configured peers read unavailable at the last probe; undefined when none failed a probe. */
  getPrimaryUnavailableReason(): string | undefined {
    return this.pool.unavailableReason("peer");
  }

  /** Why the configured fallbacks read unavailable at the last probe. */
  getFallbackUnavailableReason(): string | undefined {
    return this.pool.unavailableReason("fallback");
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  // ---------------------------------------------------------------------------
  // /props: slots, model check, model info
  // ---------------------------------------------------------------------------

  private async propsFor(url: string): Promise<LlamaServerProps | undefined> {
    let pending = this.propsCache.get(url);
    if (!pending) {
      // fetchLlamaServerProps swallows every failure; tap the fetch to see a dead endpoint go by.
      const fetchNotingDeadEndpoint: typeof fetch = async (input, init) => {
        try {
          return await this.fetchFn(input, init);
        } catch (error) {
          if (isConnectClassFailure(error) || isTimeoutAbort(error)) this.recordDownVerdict(url, error);
          throw error;
        }
      };
      pending = fetchLlamaServerProps(url, { fetch: fetchNotingDeadEndpoint, headers: this.authHeaders() });
      this.propsCache.set(url, pending);
    }
    const props = await pending;
    this.checkServedModel(url, props);
    return props;
  }

  /**
   * Judge each endpoint once, the first time its `/props` names a GGUF. One
   * that does not look like the configured model is retired: a peer serving
   * another model of the same width would return vectors the embedding model
   * guard cannot tell apart. `servedModelMatches` keeps a renamed or
   * content-addressed GGUF of the same model legitimate; an endpoint whose
   * `/props` names no file is not judged.
   */
  private checkServedModel(url: string, props: LlamaServerProps | undefined): void {
    if (!props?.modelPath || this.servedModelChecked.has(url)) return;
    this.servedModelChecked.add(url);
    if (servedModelMatches(this.model, props.modelPath)) return;
    this.servedModelMismatches.set(url, props.modelPath);
    this.pool.retire(url);
    this.log(
      `[llama-server] ${url} loaded ${props.modelPath}, which does not look like EMBEDDING_MODEL=${this.model}; ` +
        `no embedding requests go to it. ` +
        `Fetch the matching GGUF with: tea-rags llama-server fetch-model ${this.model} ` +
        `and print its launch line with: tea-rags llama-server command`,
    );
  }

  /** Every configured endpoint serves another model: a configuration error, not worth a recovery wait. */
  private failWhenNoEndpointServesModel(): void {
    const endpoints = this.pool.snapshot();
    const served: LlamaServerServedModel[] = endpoints.flatMap(({ url }) => {
      const modelPath = this.servedModelMismatches.get(url);
      return modelPath === undefined ? [] : [{ url, modelPath }];
    });
    if (served.length < endpoints.length) return;
    throw new LlamaServerModelMismatchError(this.model, served);
  }

  private async fetchModelInfo(): Promise<{ model: string; contextLength: number; dimensions: number } | undefined> {
    const props = await this.propsFor(this.pool.primaryUrl());
    if (props?.nCtx === undefined) return undefined;
    if (!this.dimensionsPinned) {
      const known = getModelDimensions(this.model);
      if (known !== undefined) {
        this.dimensions = known;
      } else {
        try {
          const [probe] = await this.embedBatch(["dimension probe"]);
          if (probe.embedding.length > 0) this.dimensions = probe.embedding.length;
        } catch {
          // Keep the starting width; the composition root reports an unverified one.
        }
      }
    }
    this.cachedModelInfo = { model: this.model, contextLength: props.nCtx, dimensions: this.dimensions };
    return this.cachedModelInfo;
  }
}

/** Last path segment, across `/` and `\` separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * Does the served GGUF look like the configured model? Accepted when the file
 * name carries the model's name slug (what `fetch-model` writes:
 * `<name>@<tag>-<digest12>.gguf`), or a 12-hex digest prefix that the
 * configured reference also carries. A content-addressed blob
 * (`sha256-<hex>`, e.g. an Ollama blob served directly) cannot be judged by
 * name and is accepted.
 */
export function servedModelMatches(model: string, modelPath: string): boolean {
  const file = baseName(modelPath).toLowerCase();
  if (/^sha256[-:][0-9a-f]{64}/.test(file)) return true;
  const reference = model.toLowerCase();
  const withoutTag = reference.includes(":") ? reference.slice(0, reference.lastIndexOf(":")) : reference;
  const slug = baseName(withoutTag);
  if (slug.length > 0 && file.includes(slug)) return true;
  const digests = reference.match(/[0-9a-f]{12,}/g) ?? [];
  return digests.some((digest) => file.includes(digest.slice(0, 12)));
}
