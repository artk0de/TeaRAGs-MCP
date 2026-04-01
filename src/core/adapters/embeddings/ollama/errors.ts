/**
 * Ollama embedding provider errors.
 *
 * Hints are platform-aware: macOS suggests Ollama.app (required for GPU),
 * Linux/Windows suggest CLI commands.
 */

import { EmbeddingError } from "../errors.js";

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

export class OllamaUnavailableError extends EmbeddingError {
  /** HTTP response status from Ollama API (e.g. 429 for rate limit). Undefined for network errors. */
  readonly responseStatus?: number;

  constructor(url: string, cause?: Error, responseStatus?: number) {
    const cmd = getOllamaCommands();
    super({
      code: "INFRA_OLLAMA_UNAVAILABLE",
      message: `Ollama is not reachable at ${url}`,
      hint: `Start Ollama: ${cmd.start}, or verify OLLAMA_URL=${url}`,
      httpStatus: 503,
      cause,
    });
    this.responseStatus = responseStatus;
  }

  /** Create error when both primary and fallback URLs are unreachable. */
  static withFallback(primaryUrl: string, fallbackUrl: string, cause?: Error): OllamaUnavailableError {
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

    const error = new OllamaUnavailableError(primaryUrl, cause);
    // Override message and hint via the base class fields
    Object.defineProperty(error, "message", {
      value: `Ollama is not reachable at ${primaryUrl} (primary) or ${fallbackUrl} (fallback)`,
    });
    Object.defineProperty(error, "hint", { value: hint });
    return error;
  }
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
