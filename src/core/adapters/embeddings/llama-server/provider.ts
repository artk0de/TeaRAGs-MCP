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
  type EmbeddingProvider,
  type EmbeddingResult,
  type EmbeddingServerBatchFailure,
  type RateLimitConfig,
} from "../base.js";
import { planEmbeddingMicroBatches } from "../batch-fanout.js";
import { EmbeddingEndpointPool, parseEmbeddingEndpointList } from "../endpoint-pool.js";
import { getModelDimensions, resolveStartingDimensions } from "../utils/model-dimensions.js";
import {
  LlamaServerContextOverflowError,
  LlamaServerModelMismatchError,
  LlamaServerResponseError,
  LlamaServerUnavailableError,
  type LlamaServerServedModel,
} from "./errors.js";
import { fetchLlamaServerProps, type LlamaServerProps } from "./props.js";

/** llama-server's default port. */
export const LLAMA_SERVER_DEFAULT_URL = "http://localhost:8080";

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
  ) {
    super(`llama-server endpoint ${url} failed (${kind}): ${describe(reason)}`);
  }
}

/** The server failed the request on its SIZE; halve it. Never leaves the provider. */
class BatchSizeFailure extends Error {
  constructor(
    readonly url: string,
    readonly status: number | undefined,
    readonly body: string,
  ) {
    super(`llama-server at ${url} failed a batch on size: ${body}`);
  }
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
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

  async checkHealth(): Promise<boolean> {
    const peersUp = await this.pool.checkPeersHealth();
    const healthy = peersUp || (await this.pool.checkFallbacksHealth()) === true;
    this.syncProbeTimer();
    return healthy;
  }

  async checkPrimaryHealth(): Promise<boolean> {
    const up = await this.pool.checkPeersHealth();
    this.syncProbeTimer();
    return up;
  }

  async checkFallbackHealth(): Promise<boolean | undefined> {
    const up = await this.pool.checkFallbacksHealth();
    this.syncProbeTimer();
    return up;
  }

  observeServerBatchFailures(observer: (event: EmbeddingServerBatchFailure) => void): () => void {
    this.serverBatchFailureObservers.add(observer);
    return () => {
      this.serverBatchFailureObservers.delete(observer);
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
   * waited, so a failure below the failover threshold cannot spin.
   */
  private async embedAcrossEndpoints(
    texts: readonly string[],
    indices: number[],
    vectors: (number[] | undefined)[],
    recoveryBudgetMs: number,
  ): Promise<void> {
    const wait: RecoveryWaitState = { start: this.now(), budgetMs: recoveryBudgetMs, attempt: 0 };
    const excluded = new Set<string>();
    let queue: number[][] | undefined;

    while (queue === undefined || queue.length > 0) {
      const active = this.pool.activeEndpoints().filter((e) => !excluded.has(e.url));
      if (active.length === 0) {
        await this.waitForEndpoint(wait);
        excluded.clear();
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
        excluded.add(failure.url);
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
   * front of `queue` until it is empty. An endpoint failure puts its
   * micro-batch back at the front and stops that endpoint's workers (their
   * in-flight micro-batches finish or fail on their own); a caller failure
   * stops every worker from pulling more. Resolves once all in-flight work has
   * settled; never rejects.
   */
  private async drainMicroBatchQueue(
    queue: number[][],
    endpoints: readonly { url: string; slots: number }[],
    texts: readonly string[],
    vectors: (number[] | undefined)[],
  ): Promise<{ endpointFailures: EndpointRequestFailure[]; callerError?: Error }> {
    const endpointFailures: EndpointRequestFailure[] = [];
    const stopped = new Set<string>();
    let callerError: Error | undefined;

    const worker = async (url: string): Promise<void> => {
      while (!stopped.has(url) && callerError === undefined) {
        const microBatch = queue.shift();
        if (microBatch === undefined) return;
        try {
          await this.embedOnEndpoint(url, texts, microBatch, vectors);
        } catch (error) {
          if (error instanceof EndpointRequestFailure) {
            queue.unshift(microBatch);
            endpointFailures.push(error);
            stopped.add(url);
          } else {
            callerError ??= error instanceof Error ? error : new Error(describe(error));
          }
          return;
        }
      }
    };

    await Promise.all(
      endpoints.flatMap((endpoint) => Array.from({ length: endpoint.slots }, async () => worker(endpoint.url))),
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
      const event: EmbeddingServerBatchFailure = { failedSize: indices.length, retrySize: half, endpointUrl: url };
      for (const observer of this.serverBatchFailureObservers) observer(event);
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
    try {
      response = await this.fetchFn(`${url}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({ input: batch, model: this.model }),
        signal: AbortSignal.timeout(REQUEST_BASE_TIMEOUT_MS + batch.length * REQUEST_PER_TEXT_TIMEOUT_MS),
      });
    } catch (error) {
      const code = errorCode(error);
      if (code === "ECONNREFUSED") throw new EndpointRequestFailure(url, "refused", error);
      if (code !== undefined && SOCKET_RESET_CODES.has(code) && batch.length > 1) {
        throw new BatchSizeFailure(url, undefined, describe(error));
      }
      throw new EndpointRequestFailure(url, "transient", error);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if ((response.status === 400 || response.status === 500) && SIZE_FAILURE_BODY.test(body)) {
        throw new BatchSizeFailure(url, response.status, body);
      }
      if (response.status >= 500 || response.status === 429) {
        throw new EndpointRequestFailure(url, "transient", `HTTP ${response.status}: ${body}`);
      }
      throw new LlamaServerResponseError(url, response.status, body);
    }

    let parsed: LlamaServerEmbeddingsResponse;
    try {
      parsed = (await response.json()) as LlamaServerEmbeddingsResponse;
    } catch (error) {
      throw new EndpointRequestFailure(url, "transient", error);
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
      );
    }
    return embeddings as number[][];
  }

  // ---------------------------------------------------------------------------
  // Health, failback and recovery wait
  // ---------------------------------------------------------------------------

  private noteEndpointFailure(failure: EndpointRequestFailure): void {
    this.pool.recordEndpointFailure(failure.url, failure.kind);
    this.propsCache.delete(failure.url);
    this.syncProbeTimer();
  }

  /**
   * No endpoint is usable. Probe every endpoint directly (the pool's own
   * interval gate is for the background timer, not for a caller that is
   * already blocked), then back off until the call's budget is spent. A zero
   * budget still makes that one direct probe: an endpoint that is back answers.
   */
  private async waitForEndpoint(wait: RecoveryWaitState): Promise<void> {
    this.failWhenNoEndpointServesModel();
    if (await this.reprobeAll()) return;
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
  }

  private async reprobeAll(): Promise<boolean> {
    const peersUp = await this.pool.checkPeersHealth();
    const up = peersUp || (await this.pool.checkFallbacksHealth()) === true;
    this.syncProbeTimer();
    return up;
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

  private async probeHealth(url: string): Promise<boolean> {
    const response = await this.fetchFn(`${url}/health`, {
      method: "GET",
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return response.ok;
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
      pending = fetchLlamaServerProps(url, { fetch: this.fetchFn, headers: this.authHeaders() });
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
