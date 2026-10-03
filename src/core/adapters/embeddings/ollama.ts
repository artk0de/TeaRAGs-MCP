/**
 * OllamaEmbeddings - OPTIMIZED with native batch API
 *
 * KEY OPTIMIZATION: Uses /api/embed instead of /api/embeddings
 * - /api/embeddings: Single text per request (OLD)
 * - /api/embed: Array of texts in one request (NEW, since Ollama 0.2.0)
 *
 * Performance improvement: N HTTP requests → 1 request
 *
 * Sources:
 * - https://docs.ollama.com/capabilities/embeddings
 * - https://ollama.com/blog/embedding-models
 */

import Bottleneck from "bottleneck";

import { isDebug } from "../../infra/runtime.js";
import type { EmbeddingProvider, EmbeddingResult, EmbeddingServerBatchFailure, RateLimitConfig } from "./base.js";
import {
  isOllamaRunnerCrashBody,
  OllamaContextOverflowError,
  OllamaMalformedResponseError,
  OllamaModelMissingError,
  OllamaResponseError,
  OllamaRunnerCrashError,
  OllamaTimeoutError,
  OllamaUnavailableError,
} from "./ollama/errors.js";
import { parseModelInfo, type OllamaModelInfo } from "./ollama/model-info.js";
import {
  provisionQuantizedOllamaModel,
  resolveOllamaQuantizationLevel,
  type OllamaQuantizationLevel,
} from "./ollama/model-quantization.js";
import { withRateLimitRetry } from "./retry.js";
import { resolveStartingDimensions } from "./utils/model-dimensions.js";

/** Full request timeout for single embed calls (connect + model load + inference).
 *  30s allows for cold model loads after successful health check. */
const SINGLE_EMBED_TIMEOUT_MS = 30_000;
/** Timeout for lightweight health probe (GET /). Generous on purpose: a box
 *  that is mid model-load or behind LAN jitter can stall a 1s GET / while
 *  still being perfectly able to serve embeds a moment later. */
const HEALTH_PROBE_TIMEOUT_MS = 3_000;
/** Probe attempts before declaring the primary unreachable. One retry absorbs
 *  sub-second jitter (cold model load, LAN blip) that would otherwise flip the
 *  whole run onto the fallback endpoint on a single dropped probe. */
const HEALTH_PROBE_ATTEMPTS = 2;
/** Pause between probe attempts. Same shape as the tune config's
 *  healthCheckRetryDelayMs default (250ms). */
const HEALTH_PROBE_RETRY_DELAY_MS = 250;
/** Minimum time after primary failure before allowing recovery */
const RECOVERY_COOLDOWN_MS = 60_000;
/** How long to cache checkHealth() result before re-probing */
const HEALTH_CACHE_TTL_MS = 60_000;
/**
 * Per-item timeout budget for batch requests.
 * Total timeout = BATCH_PER_ITEM_TIMEOUT_MS × batchSize + BATCH_BASE_TIMEOUT_MS.
 * Ollama processes batches synchronously — large batches need proportionally more time.
 */
const BATCH_BASE_TIMEOUT_MS = 30_000; // 30s base (model loading, warmup)
const BATCH_PER_ITEM_TIMEOUT_MS = 200; // 200ms per item (accounts for GPU queue with concurrent workers)

/**
 * Cap on a single connection-recovery backoff pause. Exponential backoff grows
 * per attempt but is clamped here so the re-probe cadence stays bounded across
 * a long recovery-wait budget (a host that recovers mid-wait is retried within
 * ≤30s of coming back, not after a runaway 2^n delay).
 */
const UNAVAILABLE_RETRY_MAX_DELAY_MS = 30_000;
/** Default base backoff between connection-recovery attempts when unset. */
const UNAVAILABLE_RETRY_DEFAULT_BASE_DELAY_MS = 2_000;
/**
 * Default consecutive failed embeds on the primary before failing over while
 * its `GET /` still answers (bd tea-rags-mcp-80maa). One failure is a blip (a
 * model reload, one dropped connection); three in a row with no success
 * between them is a broken embed path. Inside a recovery wait that costs
 * ~2s + 4s of backoff instead of the whole 240s budget.
 */
const FAILOVER_CONSECUTIVE_FAILURES_DEFAULT = 3;
/**
 * Ceiling for the per-request embedding window (`num_ctx` = `num_batch`). A
 * chunk is capped in characters, and even at one token per character the
 * chunk-size cap stays well inside 8192 tokens.
 */
const EMBED_WINDOW_MAX_TOKENS = 8192;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = SINGLE_EMBED_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** A hook's failure is its own: it must not fail the decision every embed waits on. */
function runEndpointResolvedHook(hook: () => void): void {
  try {
    hook();
  } catch (error) {
    console.error("[Ollama] endpoint-resolved hook failed:", error);
  }
}

/** Detect "input length exceeds context" error from Ollama response body. */
function isContextOverflow(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes("context length") || lower.includes("input length");
}

interface OllamaError {
  status?: number;
  message?: string;
}

// Legacy /api/embeddings response format (single)
interface OllamaEmbedResponse {
  embedding: number[];
}

// New /api/embed response format (batch)
interface OllamaEmbedBatchResponse {
  model: string;
  embeddings: number[][]; // Array of embedding vectors
}

/** How often to probe primary URL when operating on fallback */
const PRIMARY_PROBE_INTERVAL_MS = 30_000;

/** Event emitted when Ollama switches between primary and fallback URLs. */
export interface FallbackSwitchEvent {
  direction: "to-fallback" | "to-primary";
  primaryUrl: string;
  fallbackUrl: string;
  reason: string;
}

/**
 * Emitted while a request waits for an unreachable Ollama to come back
 * (EMBEDDING_TUNE_UNAVAILABLE_RETRY_*): `waiting` before each backoff pause,
 * `recovered` when a request that had to wait finally got through. The wait
 * gives up with the typed `OllamaUnavailableError`, not with an event.
 */
export type OllamaRecoveryWaitEvent =
  | { state: "waiting"; url: string; elapsedMs: number; budgetMs: number }
  | { state: "recovered"; url: string; elapsedMs: number };

export class OllamaEmbeddings implements EmbeddingProvider {
  /** The model embed calls carry — the quantized tag once provisioning switched to it. */
  private model: string;
  /**
   * Vector width this provider reports. Starts as the static model-registry
   * guess and is corrected by `resolveModelInfo()` once Ollama has been asked
   * what the model really is — unless an operator pinned it explicitly.
   */
  private dimensions: number;
  /** True when the width came from configuration, which outranks any probe. */
  private readonly dimensionsPinned: boolean;
  private readonly limiter: Bottleneck;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly unavailableRetryMaxWaitMs: number;
  private readonly unavailableRetryBaseDelayMs: number;
  private readonly failoverConsecutiveFailures: number;
  /**
   * Embed calls that ran against the primary and failed on the endpoint's side,
   * in completion order with no success between them. Per instance, so every
   * worker sharing this provider feeds the same count; JS runs each update to
   * completion, so concurrent failures cross the threshold exactly once.
   */
  private consecutivePrimaryFailures = 0;
  private readonly baseUrl: string;
  private readonly fallbackBaseUrl?: string;
  private readonly numGpu: number;
  private useNativeBatch: boolean;
  private usingFallback = false;
  private probeTimer?: ReturnType<typeof setInterval>;
  private primaryAlive = false;
  private primaryAliveAt = 0;
  private primaryFailedAt = 0;
  private cachedModelInfo?: OllamaModelInfo;
  /** The `/api/show` probe currently on the wire, so concurrent callers share one round trip. */
  private modelInfoInFlight?: Promise<OllamaModelInfo | undefined>;
  /** The endpoint decision once something asked for it — see `resolveEndpoint`. */
  private endpointResolution?: Promise<void>;
  private endpointResolved = false;
  private readonly endpointResolvedHooks: (() => void)[] = [];
  /** Resolves once the quantized model copy (if any) is provisioned and live. */
  private readonly modelReady?: Promise<void>;
  private readonly quantizationLevel: OllamaQuantizationLevel = "off";
  /** Largest native batch the server has handled since it last failed on one; unset until a failure. */
  private maxServerBatchSize?: number;
  /** See `observeServerBatchFailures`. */
  private readonly serverBatchFailureObservers = new Set<(event: EmbeddingServerBatchFailure) => void>();
  private lastHealthResult?: boolean;
  private lastHealthAt = 0;

  /** Optional callback for fallback switch observability. Set by pipeline wiring. */
  onFallbackSwitch?: (event: FallbackSwitchEvent) => void;

  /**
   * Optional callback for the connection-recovery wait. Without it the wait is
   * visible only under DEBUG, so an index run sat silent for the whole budget
   * before printing the error (bd tea-rags-mcp-umatc). Set by the CLI wiring.
   */
  onRecoveryWait?: (event: OllamaRecoveryWaitEvent) => void;

  constructor(
    model = "unclemusclez/jina-embeddings-v2-base-code:latest",
    dimensions?: number,
    rateLimitConfig?: RateLimitConfig,
    baseUrl = "http://localhost:11434",
    legacyApi = false,
    numGpu = 999,
    fallbackBaseUrl?: string,
  ) {
    this.model = model;
    this.baseUrl = baseUrl;
    this.fallbackBaseUrl = fallbackBaseUrl;
    this.numGpu = numGpu;
    // Enable native batch by default unless legacyApi is true
    this.useNativeBatch = !legacyApi;

    this.dimensionsPinned = dimensions !== undefined && dimensions > 0;
    this.dimensions = resolveStartingDimensions(model, dimensions, 768);

    // Rate limiting configuration (more lenient for local models)
    const maxRequestsPerMinute = rateLimitConfig?.maxRequestsPerMinute || 1000;
    this.retryAttempts = rateLimitConfig?.retryAttempts || 3;
    this.retryDelayMs = rateLimitConfig?.retryDelayMs || 500;
    // Connection-recovery wait. Defaults to 0 (abort on first connection
    // failure) so directly-constructed instances keep legacy behavior; the
    // production path enables it via config → factory → rateLimitConfig.
    this.unavailableRetryMaxWaitMs = rateLimitConfig?.unavailableRetryMaxWaitMs ?? 0;
    this.unavailableRetryBaseDelayMs =
      rateLimitConfig?.unavailableRetryBaseDelayMs || UNAVAILABLE_RETRY_DEFAULT_BASE_DELAY_MS;
    this.failoverConsecutiveFailures =
      rateLimitConfig?.failoverConsecutiveFailures ?? FAILOVER_CONSECUTIVE_FAILURES_DEFAULT;

    this.limiter = new Bottleneck({
      reservoir: maxRequestsPerMinute,
      reservoirRefreshAmount: maxRequestsPerMinute,
      reservoirRefreshInterval: 60 * 1000,
      maxConcurrent: 10,
      minTime: Math.floor((60 * 1000) / maxRequestsPerMinute),
    });

    // No endpoint probe here: `resolveEndpoint` runs it on first need, so a
    // process that never embeds (a cold `tea-rags call get_callers`) never
    // waits out an unreachable primary (bd tea-rags-mcp-xi2r9, B3).

    this.quantizationLevel = resolveOllamaQuantizationLevel(rateLimitConfig?.ollamaQuantization);
    if (this.quantizationLevel !== "off") {
      this.modelReady = this.applyQuantizedModel();
    }
  }

  /**
   * Gate every embed path waits on: the endpoint failover decision AND the
   * quantized-model provisioning. The decision is made here, on first need;
   * the provisioning is constructor-armed. Awaiting both is what keeps a first
   * embed from racing either.
   */
  private async startupReady(): Promise<void> {
    await this.resolveEndpoint();
    await this.modelReady;
  }

  /**
   * Decide, once, which endpoint the embeds go to: with a fallback configured
   * the primary is probed (`checkInitialHealth`), without one there is nothing
   * to decide. Every caller shares the one decision; the endpoint-resolved
   * hooks run right after it, before any caller proceeds.
   */
  async resolveEndpoint(): Promise<void> {
    this.endpointResolution ??= (async () => {
      if (this.fallbackBaseUrl) await this.checkInitialHealth();
      this.endpointResolved = true;
      for (const hook of this.endpointResolvedHooks.splice(0)) runEndpointResolvedHook(hook);
    })();
    return this.endpointResolution;
  }

  /** Run `hook` once the endpoint is decided — now, if it already is. Never starts the decision. */
  whenEndpointResolved(hook: () => void): void {
    if (this.endpointResolved) runEndpointResolvedHook(hook);
    else this.endpointResolvedHooks.push(hook);
  }

  /**
   * Hold an embed until a model-info probe already on the wire has answered, so
   * the first request of a run carries the context window. Never STARTS a probe:
   * the composition root and the index path resolve model info, and a failed
   * probe must not turn into one `/api/show` per embed request.
   */
  private async awaitPendingModelInfo(): Promise<void> {
    await this.modelInfoInFlight;
  }

  /**
   * Runtime options for an embed request.
   *
   * `num_ctx` and `num_batch` are pinned to the model's context length because
   * Ollama's defaults (`n_ctx` 4096, `n_batch` = `n_ubatch` 2048) cap a single
   * embedding input at 2048 tokens: a non-causal input must fit one ubatch. An
   * input past that is, nondeterministically, either silently truncated to 2048
   * tokens or fails the WHOLE request with HTTP 400 "input length exceeds the
   * context length" — dense prose (Cyrillic markdown) at the chunk-size cap
   * crosses it. With both options at the model's context length the input
   * embeds in full, and anything past the model's own limit truncates with 200.
   * The window is capped at `EMBED_WINDOW_MAX_TOKENS`: the runner's compute
   * buffers grow with `num_batch`, and a 32K–40K model (qwen3-embedding) would
   * pay that VRAM for inputs the chunk cap never produces.
   * Unknown context length → the options are omitted, leaving server defaults.
   */
  private embedRequestOptions(): Record<string, number> {
    const contextLength = this.cachedModelInfo?.contextLength;
    if (contextLength === undefined || contextLength <= 0) return { num_gpu: this.numGpu };
    const window = Math.min(contextLength, EMBED_WINDOW_MAX_TOKENS);
    return { num_gpu: this.numGpu, num_ctx: window, num_batch: window };
  }

  /** Provision (or reuse) the server-side quantized copy and switch to it. */
  private async applyQuantizedModel(): Promise<void> {
    const provision = await provisionQuantizedOllamaModel({
      baseUrl: this.baseUrl,
      baseModel: this.model,
      level: this.quantizationLevel,
    });
    if (provision.quantized) {
      this.model = provision.effectiveModel;
      if (isDebug()) {
        console.error(`[Ollama] embedding with quantized ${provision.effectiveModel} (${this.quantizationLevel})`);
      }
    } else if (provision.warning) {
      // Unconditional: silently different vectors are fine, silently worse
      // throughput the operator asked to fix is not.
      console.error(`[Ollama] ${provision.warning}`);
    }
  }

  private emitFallbackSwitch(direction: FallbackSwitchEvent["direction"], reason: string): void {
    if (this.onFallbackSwitch && this.fallbackBaseUrl) {
      this.onFallbackSwitch({
        direction,
        primaryUrl: this.baseUrl,
        fallbackUrl: this.fallbackBaseUrl,
        reason,
      });
    }
  }

  private isOllamaError(e: unknown): e is OllamaError {
    return typeof e === "object" && e !== null && ("status" in e || "message" in e);
  }

  private isRateLimit(error: unknown): boolean {
    // Check responseStatus on OllamaResponseError (HTTP 429 from Ollama)
    if (error instanceof OllamaResponseError && error.responseStatus === 429) return true;
    // Check OllamaError-shaped objects (from rejected fetch with rate limit message)
    const apiError = this.isOllamaError(error) ? error : { status: 0, message: String(error) };
    return (
      apiError.status === 429 ||
      (typeof apiError.message === "string" && apiError.message.toLowerCase().includes("rate limit"))
    );
  }

  /** Start background probe that pings primary every 30s. On success, switch back. */
  private startPrimaryProbe(): void {
    if (this.probeTimer) return;
    this.probeTimer = setInterval(() => {
      void this.probePrimary();
    }, PRIMARY_PROBE_INTERVAL_MS);
    // Don't keep process alive just for the probe
    if (this.probeTimer && typeof this.probeTimer === "object" && "unref" in this.probeTimer) {
      this.probeTimer.unref();
    }
  }

  private stopPrimaryProbe(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
  }

  /**
   * Probe the primary endpoint with GET /. Retries transport failures (timeout,
   * connection refused) once after a short delay — a live server answering
   * non-ok is a deterministic signal and is NOT retried. Returns the outcome
   * so callers keep their distinct switch reasons.
   */
  private async probeEndpointOutcome(): Promise<"ok" | "non-ok" | "unreachable"> {
    for (let attempt = 1; attempt <= HEALTH_PROBE_ATTEMPTS; attempt++) {
      try {
        const response = await fetchWithTimeout(`${this.baseUrl}/`, { method: "GET" }, HEALTH_PROBE_TIMEOUT_MS);
        return response.ok ? "ok" : "non-ok";
      } catch {
        if (attempt < HEALTH_PROBE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, HEALTH_PROBE_RETRY_DELAY_MS));
        }
      }
    }
    return "unreachable";
  }

  private async checkInitialHealth(): Promise<void> {
    const outcome = await this.probeEndpointOutcome();
    if (outcome === "ok") {
      this.primaryAlive = true;
      this.primaryAliveAt = Date.now();
      // Monitor primary for runtime failures — symmetric to recovery probe.
      // Detection-only: probe never switches URL mid-operation (snapshot invariant).
      this.startPrimaryProbe();
    } else if (outcome === "non-ok") {
      this.switchToFallback("initial health check non-ok");
    } else {
      this.switchToFallback(`initial health check failed (${HEALTH_PROBE_ATTEMPTS} attempts)`);
    }
  }

  private switchToFallback(reason: string): void {
    this.usingFallback = true;
    this.consecutivePrimaryFailures = 0;
    this.primaryAlive = false;
    this.primaryFailedAt = Date.now();
    this.startPrimaryProbe();
    if (isDebug()) {
      console.error(`[Ollama] ${reason}, using fallback ${this.fallbackBaseUrl}`);
    }
    this.emitFallbackSwitch("to-fallback", reason);
  }

  private async probePrimary(): Promise<void> {
    const alive = (await this.probeEndpointOutcome()) === "ok";

    if (this.usingFallback) {
      // Recovery direction: fallback → primary
      if (alive) {
        if (Date.now() - this.primaryFailedAt < RECOVERY_COOLDOWN_MS) {
          return;
        }
        this.usingFallback = false;
        this.consecutivePrimaryFailures = 0;
        this.primaryAlive = true;
        this.primaryAliveAt = Date.now();
        if (isDebug()) {
          console.error(`[Ollama] Primary ${this.baseUrl} recovered, switching back from fallback`);
        }
        this.emitFallbackSwitch("to-primary", "primary recovered (health probe OK)");
      }
      // else: still down — probe continues
    } else if (!alive && this.fallbackBaseUrl) {
      // Detection direction: primary died mid-session → switch to fallback.
      // State-only mutation: in-flight operations keep their URL snapshot.
      this.switchToFallback("primary health probe failed");
    }
  }

  /** Return current active URL without health checks (no-fallback path). */
  private resolveActiveUrl(): string {
    return this.usingFallback && this.fallbackBaseUrl ? this.fallbackBaseUrl : this.baseUrl;
  }

  /**
   * Did the ENDPOINT fail this embed, as opposed to the caller's input? A
   * caller-side 4xx (context overflow, missing model, bad request, rate limit
   * once its own retries are spent) would fail the same way on any endpoint,
   * so it says nothing about the primary. Everything else — transport error,
   * timeout, 5xx, malformed body — does.
   */
  private isEndpointFailure(error: unknown): boolean {
    if (error instanceof OllamaModelMissingError) return false;
    // A runner that died under an oversized batch is a batch-size fact, not a
    // sick endpoint: concurrent crashing batches would otherwise cross the
    // failover threshold before the first split half could succeed.
    if (error instanceof OllamaRunnerCrashError) return false;
    if (error instanceof OllamaResponseError && error.responseStatus >= 400 && error.responseStatus < 500) {
      return false;
    }
    return !this.isRateLimit(error);
  }

  /** A success on the primary ends the run of consecutive failures. */
  private notePrimaryEmbedSuccess(url: string): void {
    if (url === this.baseUrl) this.consecutivePrimaryFailures = 0;
  }

  /**
   * Count an embed that failed on the primary; fail over once the run reaches
   * the threshold (bd tea-rags-mcp-80maa). This is the only path for a primary
   * that still answers `GET /` — the startup check and the background probe
   * both see it healthy. The way back stays with the probe and its cooldown.
   * Only calls whose URL snapshot was the primary count, and only while the
   * primary is active: an in-flight call landing after the switch neither
   * re-switches nor counts toward the next run. Returns true when it switched.
   */
  private notePrimaryEmbedFailure(url: string, error: unknown): boolean {
    if (!this.fallbackBaseUrl || this.failoverConsecutiveFailures <= 0) return false;
    if (this.usingFallback || url !== this.baseUrl) return false;
    if (!this.isEndpointFailure(error)) return false;
    this.consecutivePrimaryFailures += 1;
    if (this.consecutivePrimaryFailures < this.failoverConsecutiveFailures) return false;
    this.switchToFallback(`${this.consecutivePrimaryFailures} consecutive embed failures on primary`);
    return true;
  }

  /**
   * Did the server fail on the SIZE of a native batch? A crashed runner
   * (`OllamaRunnerCrashError`, whatever status relayed it) or any other 5xx.
   * A caller-side 4xx fails identically at any size, and a timeout does not
   * shrink with the batch (the same work under a smaller budget), so neither
   * is split.
   */
  private isServerBatchFailure(error: unknown): boolean {
    if (error instanceof OllamaRunnerCrashError) return true;
    return error instanceof OllamaResponseError && error.responseStatus >= 500;
  }

  /**
   * Watch the native batches the server fails on SIZE (bd tea-rags-mcp-7ju66).
   * While at least one observer is attached the provider stops pinning a
   * run-long batch ceiling of its own: the observer (the ingest pipeline's
   * throughput tuner) owns the working size and may recover it upward. The
   * failing call itself still bisects to completion. Returns the detach.
   */
  observeServerBatchFailures(observer: (event: EmbeddingServerBatchFailure) => void): () => void {
    this.serverBatchFailureObservers.add(observer);
    return () => {
      this.serverBatchFailureObservers.delete(observer);
    };
  }

  /** One native request for exactly `texts`. */
  private async embedNativeOnce(texts: string[]): Promise<EmbeddingResult[]> {
    const batchEmbed = async (url: string): Promise<EmbeddingResult[]> => {
      const timeout = this.batchTimeout(texts.length);
      if (isDebug()) {
        console.error(`[Ollama] Native batch: ${texts.length} texts in 1 request to ${url} (timeout=${timeout}ms)`);
      }
      const response = await this.callBatchApi(texts, url, timeout);
      if (response.embeddings?.length !== texts.length) {
        throw new OllamaMalformedResponseError(url, texts.length, response.embeddings?.length ?? 0);
      }
      return response.embeddings.map((embedding: number[]) => ({
        embedding,
        dimensions: this.dimensions,
      }));
    };
    return this.limiter.schedule(async () => this.retryWithBackoff(async (url) => batchEmbed(url)));
  }

  /**
   * Embed `texts` natively, never sending more than `bound.ceiling` in one
   * request. A batch the server fails on size is halved and its slices sent
   * one after another; the halved size becomes the bound for the rest of THIS
   * call — and, when nobody observes, for the rest of the run: each failure
   * costs a runner restart plus a model reload on the server.
   */
  private async embedNativeBounded(
    texts: string[],
    bound: { ceiling: number | undefined; observed: boolean },
  ): Promise<EmbeddingResult[]> {
    if (bound.ceiling !== undefined && texts.length > bound.ceiling) {
      return this.embedNativeSlices(texts, bound.ceiling, bound);
    }
    try {
      return await this.embedNativeOnce(texts);
    } catch (error) {
      if (texts.length <= 1 || !this.isServerBatchFailure(error)) throw error;
      const half = Math.ceil(texts.length / 2);
      bound.ceiling = Math.min(bound.ceiling ?? half, half);
      if (!bound.observed) this.maxServerBatchSize = Math.min(this.maxServerBatchSize ?? half, half);
      // Unconditional: a batch size the server cannot take is an operator-facing
      // tuning fact (EMBEDDING_TUNE_BATCH_SIZE), not debug noise.
      console.error(
        `[Ollama] server failed a ${texts.length}-text batch (${error instanceof Error ? error.message : String(error)}); ` +
          `retrying in batches of ${half}`,
      );
      const event: EmbeddingServerBatchFailure = {
        failedSize: texts.length,
        retrySize: half,
        endpointUrl: this.getBaseUrl(),
      };
      for (const observer of this.serverBatchFailureObservers) observer(event);
      return this.embedNativeSlices(texts, half, bound);
    }
  }

  /** Embed consecutive slices one after another, preserving input order. */
  private async embedNativeSlices(
    texts: string[],
    sliceSize: number,
    bound: { ceiling: number | undefined; observed: boolean },
  ): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    for (let start = 0; start < texts.length; start += sliceSize) {
      results.push(...(await this.embedNativeBounded(texts.slice(start, start + sliceSize), bound)));
    }
    return results;
  }

  private async retryWithBackoff<T>(fn: (url: string) => Promise<T>): Promise<T> {
    const recoveryStart = Date.now();
    const recoveryDeadline = recoveryStart + this.unavailableRetryMaxWaitMs;
    let recoveryAttempt = 0;

    for (;;) {
      const url = this.resolveActiveUrl();
      try {
        const result = await withRateLimitRetry(async () => fn(url), {
          maxAttempts: this.retryAttempts,
          baseDelayMs: this.retryDelayMs,
          // A malformed 200 (no vectors / wrong count) is a transient server
          // hiccup on a reachable host — retry it here, not in the recovery wait.
          isRetryable: (error) => this.isRateLimit(error) || error instanceof OllamaMalformedResponseError,
          describeRetry: (error) =>
            error instanceof OllamaMalformedResponseError ? "Malformed Ollama embed response" : undefined,
        });
        this.notePrimaryEmbedSuccess(url);
        if (recoveryAttempt > 0) {
          this.onRecoveryWait?.({ state: "recovered", url, elapsedMs: Date.now() - recoveryStart });
        }
        return result;
      } catch (error) {
        // This failure just moved us to the fallback: retry the same call there
        // now, whatever the error type and whatever the recovery budget. The
        // switch is the only thing that changed, and it means there is another
        // endpoint to ask — rethrowing would fail the call that crossed the
        // threshold, and a caller that allows exactly threshold-many attempts
        // (the pre-run health probe) would die having never called the
        // fallback (bd tea-rags-mcp-sbu0s). Terminates: once on the fallback,
        // notePrimaryEmbedFailure never reports another switch.
        if (this.notePrimaryEmbedFailure(url, error)) continue;

        // The active endpoint moved while this call was in flight — the
        // background probe (or a concurrent caller crossing the threshold)
        // switched away from the URL snapshot it ran against. The failure says
        // nothing about the endpoint now active, so ask that one instead of
        // rethrowing (bd tea-rags-mcp-sbu0s residual race). Terminates: a
        // switch back to the primary is gated by the probe's recovery cooldown.
        if (url !== this.resolveActiveUrl()) continue;

        // Typed errors propagate directly — the server IS reachable but rejected
        // the request (missing model, timeout, HTTP error, malformed body whose
        // retries are spent), so waiting for a reconnection is pointless. No
        // recovery wait; the failure has already been counted toward failover
        // above without reaching the threshold.
        if (error instanceof OllamaMalformedResponseError) throw error;
        if (error instanceof OllamaModelMissingError) throw error;
        if (error instanceof OllamaTimeoutError) throw error;
        if (error instanceof OllamaResponseError) throw error;
        if (error instanceof OllamaRunnerCrashError) throw error;

        // Connection-level unavailability (both endpoints unreachable). A remote
        // host under sustained embedding load can flap — crash/restart → briefly
        // unreachable → recover when idle. Retry with exponential backoff until
        // the bounded wall-clock budget is spent, instead of aborting the whole
        // index on the first failure. Fallback URL is re-resolved each iteration,
        // so a fallback that recovers first is picked up automatically.
        const cause = error instanceof Error ? error : undefined;
        const remainingMs = recoveryDeadline - Date.now();
        if (remainingMs > 0) {
          const delayMs = Math.min(
            this.unavailableRetryBaseDelayMs * 2 ** recoveryAttempt,
            UNAVAILABLE_RETRY_MAX_DELAY_MS,
            remainingMs,
          );
          recoveryAttempt += 1;
          if (isDebug()) {
            console.error(
              `[Ollama] Not reachable at ${url}. Waiting ${(delayMs / 1000).toFixed(1)}s for recovery ` +
                `(~${Math.ceil(remainingMs / 1000)}s of budget left, attempt ${recoveryAttempt})...`,
            );
          }
          this.onRecoveryWait?.({
            state: "waiting",
            url,
            elapsedMs: Date.now() - recoveryStart,
            budgetMs: this.unavailableRetryMaxWaitMs,
          });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        // Recovery budget exhausted (or disabled) — abort. The error carries the wait already spent so a caller does not spend
        // the operator's budget a second time (bd tea-rags-mcp-umatc).
        const recoveryWaitMs = recoveryAttempt > 0 ? Date.now() - recoveryStart : 0;
        if (this.usingFallback && this.fallbackBaseUrl) {
          throw OllamaUnavailableError.withFallback(this.baseUrl, this.fallbackBaseUrl, cause, recoveryWaitMs);
        }

        throw new OllamaUnavailableError(url, cause, undefined, recoveryWaitMs);
      }
    }
  }

  /**
   * NEW: Native batch embedding using /api/embed
   * Sends all texts in ONE request instead of N separate requests
   */
  private async callBatchApi(texts: string[], url?: string, timeoutMs?: number): Promise<OllamaEmbedBatchResponse> {
    const baseUrl = url ?? this.baseUrl;
    const effectiveTimeout = timeoutMs ?? this.batchTimeout(texts.length);

    // Own AbortController with timedOut flag — distinguishes our timeout from other aborts
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeout);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          options: this.embedRequestOptions(),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new OllamaTimeoutError(
          baseUrl,
          texts.length,
          effectiveTimeout,
          error instanceof Error ? error : undefined,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      /* v8 ignore next 3 -- legacy API 404 path, tested via native batch */
      if (response.status === 404 || errorBody.includes("not found")) {
        throw new OllamaModelMissingError(this.model, baseUrl);
      }
      if (isContextOverflow(errorBody)) {
        throw new OllamaContextOverflowError(baseUrl, response.status, errorBody);
      }
      if (isOllamaRunnerCrashBody(errorBody)) {
        throw new OllamaRunnerCrashError(baseUrl, response.status, errorBody);
      }
      throw new OllamaResponseError(baseUrl, response.status, errorBody);
    }

    return response.json() as Promise<OllamaEmbedBatchResponse>;
  }

  /**
   * Legacy single embedding using /api/embeddings
   * Fallback for older Ollama versions
   */
  private async callApi(text: string, url?: string): Promise<OllamaEmbedResponse> {
    const baseUrl = url ?? this.baseUrl;
    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: text,
          options: this.embedRequestOptions(),
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 404 || errorBody.includes("not found")) {
          throw new OllamaModelMissingError(this.model, baseUrl);
        }
        if (isContextOverflow(errorBody)) {
          throw new OllamaContextOverflowError(baseUrl, response.status, errorBody);
        }
        if (isOllamaRunnerCrashBody(errorBody)) {
          throw new OllamaRunnerCrashError(baseUrl, response.status, errorBody);
        }
        throw new OllamaResponseError(baseUrl, response.status, errorBody);
      }

      return response.json() as Promise<OllamaEmbedResponse>;
    } catch (error) {
      // Re-throw typed errors (from !response.ok block)
      if (
        error instanceof OllamaModelMissingError ||
        error instanceof OllamaResponseError ||
        error instanceof OllamaRunnerCrashError
      ) {
        throw error;
      }

      // Detect rate limit from network-level rejection (raw error with rate limit message)
      const rawMessage = this.isOllamaError(error) ? error.message : undefined;
      if (
        (this.isOllamaError(error) && error.status === 429) ||
        (typeof rawMessage === "string" && rawMessage.toLowerCase().includes("rate limit"))
      ) {
        throw new OllamaResponseError(baseUrl, 429, rawMessage ?? "rate limited");
      }

      // Network errors → server unavailable
      throw new OllamaUnavailableError(baseUrl, error instanceof Error ? error : undefined);
    }
  }

  /** Full request timeout — probe handles fast failover, embed gets full budget. */
  /* v8 ignore next 3 -- timeout constant, exercised via integration tests */
  private singleEmbedTimeout(): number {
    return SINGLE_EMBED_TIMEOUT_MS;
  }

  /** Timeout scaled for batch size — large batches need proportionally more time */
  /* v8 ignore next 5 -- exercised via integration; unit tests use mocked embeddings */
  private batchTimeout(batchSize: number): number {
    const singleTimeout = this.singleEmbedTimeout();
    if (batchSize <= 1) return singleTimeout;
    return Math.max(singleTimeout, BATCH_BASE_TIMEOUT_MS + batchSize * BATCH_PER_ITEM_TIMEOUT_MS);
  }

  private async embedSingle(text: string, url: string): Promise<EmbeddingResult> {
    if (this.useNativeBatch) {
      const response = await this.callBatchApi([text], url, this.singleEmbedTimeout());
      if (response.embeddings?.length !== 1) {
        throw new OllamaMalformedResponseError(url, 1, response.embeddings?.length ?? 0);
      }
      return { embedding: response.embeddings[0], dimensions: this.dimensions };
    }
    const response = await this.callApi(text, url);
    if (!response.embedding) {
      throw new OllamaMalformedResponseError(url, 1, 0);
    }
    return { embedding: response.embedding, dimensions: this.dimensions };
  }

  async embed(text: string): Promise<EmbeddingResult> {
    await this.startupReady();
    await this.awaitPendingModelInfo();
    return this.limiter.schedule(async () => this.retryWithBackoff(async (url) => this.embedSingle(text, url)));
  }

  /**
   * OPTIMIZED: Native batch embeddings
   *
   * OLD: N texts → N HTTP requests (even with Promise.all, still N requests!)
   * NEW: N texts → 1 HTTP request with input array
   *
   * Performance: ~50-100x less network overhead
   *
   * Batch size configurable via EMBEDDING_BATCH_SIZE env var:
   * - 0 = use single requests with INGEST_PIPELINE_CONCURRENCY (fallback mode)
   * - 32 = conservative (recommended for limited VRAM)
   * - 64 = balanced (default, good for 8GB+ VRAM)
   * - 128-512 = aggressive (for high-end GPUs)
   * - 2048+ = benchmark showed linear scaling with AMD 12GB GPU
   *
   * Note: GPU must have num_gpu: 999 enabled (see callBatchApi)
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    await this.startupReady();
    await this.awaitPendingModelInfo();
    if (texts.length === 0) {
      return [];
    }

    // Batch size is controlled by pipeline accumulator (EMBEDDING_BATCH_SIZE env).
    // This method sends ALL received texts in a single API call.

    // Use native batch API - ONE request for ALL texts
    if (this.useNativeBatch) {
      // With an observer attached the observer owns the working size across
      // calls, so the run-long ceiling is neither applied nor recorded; the
      // call-local bound still keeps the failing call's remaining slices at the
      // size that worked.
      const observed = this.serverBatchFailureObservers.size > 0;
      return this.embedNativeBounded(texts, { ceiling: observed ? undefined : this.maxServerBatchSize, observed });
    }

    // Fallback: Legacy parallel individual requests (old Ollama without /api/embed)
    if (isDebug()) {
      console.error(`[Ollama] Fallback: ${texts.length} individual requests`);
    }
    const results: EmbeddingResult[] = [];

    for (const text of texts) {
      results.push(await this.embed(text));
    }

    return results;
  }

  /**
   * Check if Ollama supports native batch API
   * Can be used to auto-detect and fallback
   */
  async checkBatchSupport(): Promise<boolean> {
    try {
      const response = await this.callBatchApi(["test"]);
      return !!response.embeddings;
    } catch {
      console.error("[Ollama] Native batch not supported, using fallback");
      this.useNativeBatch = false;
      return false;
    }
  }

  async resolveModelInfo(): Promise<OllamaModelInfo | undefined> {
    if (this.cachedModelInfo) return this.cachedModelInfo;
    if (this.modelInfoInFlight) return this.modelInfoInFlight;
    this.modelInfoInFlight = this.fetchModelInfo().finally(() => {
      this.modelInfoInFlight = undefined;
    });
    return this.modelInfoInFlight;
  }

  private async fetchModelInfo(): Promise<OllamaModelInfo | undefined> {
    // Same ordering as embed()/checkHealth(): the active URL is only decided
    // once the failover check (`resolveEndpoint`) has settled.
    await this.startupReady();
    const url = this.resolveActiveUrl();
    try {
      const response = await fetchWithTimeout(
        `${url}/api/show`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: this.model }),
        },
        HEALTH_PROBE_TIMEOUT_MS * 5,
      );
      if (!response.ok) return undefined;

      const data = (await response.json()) as { model_info?: Record<string, unknown> };
      if (!data.model_info) return undefined;

      const info = parseModelInfo(this.model, data.model_info);
      if (info) {
        this.cachedModelInfo = info;
        // Adopt the width the server reports. The constructor could only guess
        // it from a static table, and a stale guess propagates into every
        // zero-vector artifact sized from getDimensions().
        if (!this.dimensionsPinned) this.dimensions = info.dimensions;
      }
      return info;
    } catch {
      return undefined;
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }

  async checkHealth(): Promise<boolean> {
    // Probe the endpoint the next embed will use, which the failover check
    // (`resolveEndpoint`) decides — read before it settles, the primary gets
    // probed even when failover is about to flip to the fallback (jyka).
    await this.startupReady();
    if (this.lastHealthResult !== undefined && Date.now() - this.lastHealthAt < HEALTH_CACHE_TTL_MS) {
      return this.lastHealthResult;
    }
    const url = this.usingFallback && this.fallbackBaseUrl ? this.fallbackBaseUrl : this.baseUrl;
    try {
      const response = await fetchWithTimeout(`${url}/`, { method: "GET" }, HEALTH_PROBE_TIMEOUT_MS);
      this.lastHealthResult = response.ok;
    } catch {
      this.lastHealthResult = false;
    }
    this.lastHealthAt = Date.now();
    return this.lastHealthResult;
  }

  getProviderName(): string {
    return "ollama";
  }

  /**
   * Currently-active endpoint. When primary is healthy → primary; when
   * failover has flipped to the configured fallback → fallback. Used by
   * callers that want to know "which URL is the next request going to hit"
   * (Ollama fallback observability log, runtime diagnostics).
   */
  getBaseUrl(): string {
    return this.usingFallback && this.fallbackBaseUrl ? this.fallbackBaseUrl : this.baseUrl;
  }

  /**
   * Configured primary endpoint — what the operator wired up. Ignores the
   * runtime failover state. Used by display/persistence contexts that
   * want what was CONFIGURED (prime CLI infraHealth, registry write,
   * doctor "URL the project was indexed against").
   */
  getPrimaryBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Configured fallback endpoint, regardless of whether failover is currently
   * active. Surfaced through infraHealth.embedding.fallbackUrl so the prime
   * CLI digest can show both URLs (primary + backup).
   */
  getFallbackBaseUrl(): string | undefined {
    return this.fallbackBaseUrl;
  }

  /**
   * Live reachability probe of the CONFIGURED fallback endpoint, independent of
   * runtime failover state. Returns undefined when no fallback is configured so
   * callers can omit the field; otherwise true/false for reachable-right-now.
   * Surfaced via infraHealth.embedding.fallbackAvailable so the prime CLI digest
   * shows whether the backup ollama is up — the active-endpoint `checkHealth`
   * probe never touches the fallback while the primary is alive.
   */
  async checkFallbackHealth(): Promise<boolean | undefined> {
    if (!this.fallbackBaseUrl) return undefined;
    try {
      const response = await fetchWithTimeout(`${this.fallbackBaseUrl}/`, { method: "GET" }, HEALTH_PROBE_TIMEOUT_MS);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Live reachability probe of the CONFIGURED primary endpoint, independent of
   * runtime failover state. Always targets `this.baseUrl` — unlike `checkHealth`
   * (active endpoint, returns the fallback's health once failover flips), so the
   * prime CLI digest can report the primary's true status even during failover.
   * Surfaced via infraHealth.embedding.primaryAvailable — symmetric with
   * `checkFallbackHealth`.
   */
  async checkPrimaryHealth(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/`, { method: "GET" }, HEALTH_PROBE_TIMEOUT_MS);
      return response.ok;
    } catch {
      return false;
    }
  }
}
