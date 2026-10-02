/**
 * Ollama embedding provider errors.
 *
 * Hints are platform-aware: macOS suggests Ollama.app (required for GPU),
 * Linux/Windows suggest CLI commands.
 */

import { EmbeddingError, type ProviderRecoveryWaitReporting } from "../errors.js";

interface OllamaCommands {
  start: string;
  stop: string;
}

function getOllamaCommands(): OllamaCommands {
  if (process.platform === "darwin") {
    return { start: "open -a Ollama", stop: `osascript -e 'quit app "Ollama"'` };
  }
  if (process.platform === "win32") {
    return { start: "ollama serve", stop: "taskkill /IM ollama.exe /F" };
  }
  return { start: "ollama serve", stop: "pkill ollama" };
}

export class OllamaUnavailableError extends EmbeddingError implements ProviderRecoveryWaitReporting {
  /** HTTP response status from Ollama API (e.g. 429 for rate limit). Undefined for network errors. */
  readonly responseStatus?: number;
  /**
   * Wall-clock ms the provider already spent waiting for the host to come back
   * (EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS) before giving up; 0 when it
   * gave up at once. A caller that retries on top of a spent wait multiplies
   * the operator's budget, so it reads this before trying again.
   */
  readonly recoveryWaitMs: number;

  constructor(url: string, cause?: Error, responseStatus?: number, recoveryWaitMs = 0) {
    const cmd = getOllamaCommands();
    super({
      code: "INFRA_OLLAMA_UNAVAILABLE",
      message: `Ollama is not reachable at ${url}${recoveryWaitSuffix(recoveryWaitMs)}`,
      hint: `Start Ollama: ${cmd.start}, or verify EMBEDDING_BASE_URL=${url}${recoveryWaitHint(recoveryWaitMs)}`,
      httpStatus: 503,
      cause,
    });
    this.responseStatus = responseStatus;
    this.recoveryWaitMs = recoveryWaitMs;
  }

  /** Create error when both primary and fallback URLs are unreachable. */
  static withFallback(
    primaryUrl: string,
    fallbackUrl: string,
    cause?: Error,
    recoveryWaitMs = 0,
  ): OllamaUnavailableError {
    const hasLocal = isLocalUrl(primaryUrl) || isLocalUrl(fallbackUrl);
    const cmd = getOllamaCommands();

    let hint: string;
    if (hasLocal) {
      hint =
        `Start Ollama: ${cmd.start} — or check connectivity to ${primaryUrl} and ${fallbackUrl}. ` +
        `If Ollama is stuck: ${cmd.stop}`;
    } else {
      hint = `Check network connectivity to ${primaryUrl} and ${fallbackUrl}`;
    }

    const error = new OllamaUnavailableError(primaryUrl, cause, undefined, recoveryWaitMs);
    // Override message and hint via the base class fields
    Object.defineProperty(error, "message", {
      value: `Ollama is not reachable at ${primaryUrl} (primary) or ${fallbackUrl} (fallback)${recoveryWaitSuffix(recoveryWaitMs)}`,
    });
    Object.defineProperty(error, "hint", { value: `${hint}${recoveryWaitHint(recoveryWaitMs)}` });
    return error;
  }
}

/** Message tail stating the recovery wait already spent — absent when none was. */
function recoveryWaitSuffix(recoveryWaitMs: number): string {
  return recoveryWaitMs > 0 ? ` (waited ${Math.round(recoveryWaitMs / 1000)}s for it to come back)` : "";
}

/** Hint tail naming the knob that sized the wait — absent when none was spent. */
function recoveryWaitHint(recoveryWaitMs: number): string {
  return recoveryWaitMs > 0
    ? ". A host that restarts slowly can be given longer with EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS"
    : "";
}

function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    if (hostname === "localhost") return true;

    // Check numeric IP ranges
    const parts = hostname.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;

    // 127.0.0.0/8 — loopback
    if (parts[0] === 127) return true;
    // 10.0.0.0/8 — private
    if (parts[0] === 10) return true;
    // 172.16.0.0/12 — private (172.16.x.x – 172.31.x.x)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 — private
    if (parts[0] === 192 && parts[1] === 168) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Embedding request timed out — server is alive but batch is too large
 * or inference is too slow. NOT a connectivity issue — do NOT fallback.
 */
export class OllamaTimeoutError extends EmbeddingError {
  constructor(url: string, batchSize: number, timeoutMs: number, cause?: Error) {
    super({
      code: "INFRA_OLLAMA_TIMEOUT",
      message: `Ollama embedding timed out at ${url} (${batchSize} texts, ${timeoutMs}ms limit)`,
      hint:
        `The embedding request exceeded the timeout.\n` +
        `Try reducing EMBEDDING_BATCH_SIZE (current batch: ${batchSize} texts).\n` +
        `Timeout formula: 30s base + ${batchSize} × 200ms/item = ${timeoutMs}ms`,
      httpStatus: 504,
      cause,
    });
  }
}

/**
 * The ollama server is up but the runner process serving the model died under
 * the request — the server relays its own loopback call to the runner failing
 * (`Post "http://127.0.0.1:<port>/tokenize": ... refused`) or reports the
 * process gone. Status varies by version and platform: 500, or 400 on ollama
 * 0.34.4 for Windows (measured 2026-09-27, 256–512-text batches). Neither the
 * input nor the endpoint is at fault — the batch was too large for the runner —
 * so it carries no `responseStatus` (the embed quarantine keys on it) and does
 * not count toward failover. The provider splits the batch instead.
 */
export class OllamaRunnerCrashError extends EmbeddingError {
  readonly serverStatus: number;
  readonly responseBody: string;

  constructor(url: string, status: number, body: string) {
    super({
      code: "INFRA_OLLAMA_RUNNER_CRASHED",
      message: `Ollama model runner crashed at ${url} (HTTP ${status}): ${body}`,
      hint:
        `The ollama runner process died while embedding a batch.\n` +
        `Batches are retried in halves automatically; if it persists, lower EMBEDDING_TUNE_BATCH_SIZE.\n` +
        `Check the ollama server log for the runner's exit reason.`,
      httpStatus: 502,
    });
    this.serverStatus = status;
    this.responseBody = body;
  }
}

/** The server relays a failed loopback call to its runner, or says the runner exited. */
const RUNNER_CRASH_BODY = /http:\/\/127\.0\.0\.1:\d+\/\w+.*(refused|reset|EOF|closed)|runner process has terminated/i;

/** Does this error body describe a crashed runner rather than a rejected request? */
export function isOllamaRunnerCrashBody(body: string): boolean {
  return RUNNER_CRASH_BODY.test(body);
}

/**
 * Ollama responded with an HTTP error (server is available, but returned an error).
 * Distinct from OllamaUnavailableError (no connection at all).
 */
export class OllamaResponseError extends EmbeddingError {
  readonly responseStatus: number;
  readonly responseBody: string;

  constructor(url: string, status: number, body: string) {
    super({
      code: "INFRA_OLLAMA_RESPONSE_ERROR",
      message: `Ollama HTTP ${status} at ${url}: ${body}`,
      hint: `Ollama returned an error (HTTP ${status}).\nResponse: ${body}\nCheck Ollama logs for details.`,
      httpStatus: status >= 500 ? 502 : status,
    });
    this.responseStatus = status;
    this.responseBody = body;
  }
}

/**
 * Ollama answered HTTP 200 but the body does not carry one vector per input
 * text — none at all, or the wrong count. The server IS reachable, so this is
 * not an `OllamaUnavailableError`: it is retried by the normal batch retries
 * (EMBEDDING_TUNE_RETRY_ATTEMPTS), never by the unavailable-host recovery wait.
 */
export class OllamaMalformedResponseError extends EmbeddingError {
  readonly expectedCount: number;
  readonly receivedCount: number;

  constructor(url: string, expectedCount: number, receivedCount: number) {
    const noun = expectedCount === 1 ? "vector" : "vectors";
    super({
      code: "INFRA_OLLAMA_MALFORMED_RESPONSE",
      message: `Ollama returned a malformed embed response at ${url}: expected ${expectedCount} ${noun}, got ${receivedCount}`,
      hint:
        `Ollama answered but its response did not contain one embedding per input text.\n` +
        `The request was already retried (EMBEDDING_TUNE_RETRY_ATTEMPTS). Check the Ollama logs at ${url}; ` +
        `a model that is still loading or a server under memory pressure can return partial batches.`,
      httpStatus: 502,
    });
    this.expectedCount = expectedCount;
    this.receivedCount = receivedCount;
  }
}

/**
 * A chunk exceeds the embedding model's context window.
 * Detected by Ollama response body containing "context length" or "input length".
 */
export class OllamaContextOverflowError extends OllamaResponseError {
  constructor(url: string, status: number, body: string) {
    super(url, status, body);
    Object.defineProperty(this, "code", { value: "INFRA_OLLAMA_CONTEXT_OVERFLOW" });
    Object.defineProperty(this, "hint", {
      value:
        `A code chunk exceeds the embedding model's context window.\n` +
        `Reduce INGEST_CHUNK_SIZE or use a model with larger context.\n` +
        `Model context limits: nomic-embed-text=8192, jina-v2-base-code=8192, mxbai-embed-large=512`,
    });
  }
}

export class OllamaModelMissingError extends EmbeddingError {
  constructor(model: string, url: string) {
    super({
      code: "INFRA_OLLAMA_MODEL_MISSING",
      message: `Ollama model "${model}" is not available at ${url}`,
      hint:
        `Try: ollama pull ${model}\n` +
        `If pull fails, the model name may be wrong — check EMBEDDING_MODEL in your config.\n` +
        `Available models: ollama list | Browse: https://ollama.com/search?c=embedding`,
      httpStatus: 503,
    });
  }
}

/** EMBEDDING_AUTO_PULL tried to fetch a missing model and the server could not. */
export class OllamaModelPullFailedError extends EmbeddingError {
  constructor(model: string, url: string, reason: string) {
    super({
      code: "INFRA_OLLAMA_MODEL_PULL_FAILED",
      message: `Ollama model "${model}" is missing at ${url} and pulling it failed: ${reason}`,
      hint:
        `Try: ollama pull ${model}\n` +
        `If pull fails, the model name may be wrong — check EMBEDDING_MODEL in your config.\n` +
        `Set EMBEDDING_AUTO_PULL=false to skip the automatic pull.`,
      httpStatus: 503,
    });
  }
}
