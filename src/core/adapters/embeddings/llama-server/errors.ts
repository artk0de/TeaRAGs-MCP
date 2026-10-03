/**
 * llama-server embedding provider errors.
 *
 * Only the failures that reach the caller have a class here. An endpoint that
 * refuses, times out or answers a 5xx is handled inside the provider (its texts
 * move to another endpoint); the caller sees `LlamaServerUnavailableError` only
 * once no endpoint is left and the recovery wait has run out — or
 * `LlamaServerModelMismatchError` at once when every endpoint serves another
 * model.
 */

import { EmbeddingError, type ProviderRecoveryWaitReporting } from "../errors.js";

/** Every configured endpoint, peers and fallbacks, stayed unreachable. */
export class LlamaServerUnavailableError extends EmbeddingError implements ProviderRecoveryWaitReporting {
  readonly recoveryWaitMs: number;

  constructor(peers: string, fallbacks: string | undefined, cause?: Error, recoveryWaitMs = 0) {
    const where = fallbacks ? `${peers} (peers) or ${fallbacks} (fallback)` : peers;
    const waited = recoveryWaitMs > 0 ? ` (waited ${Math.round(recoveryWaitMs / 1000)}s for one to come back)` : "";
    const waitHint =
      recoveryWaitMs > 0
        ? ". A host that restarts slowly can be given longer with EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS"
        : "";
    super({
      code: "INFRA_LLAMA_SERVER_UNAVAILABLE",
      message: `No llama-server endpoint is reachable at ${where}${waited}`,
      hint:
        `Start llama-server on the GPU host (print the launch line with: tea-rags llama-server command), ` +
        `check that the host is awake and its firewall admits the port, and verify EMBEDDING_BASE_URL=${peers}${waitHint}`,
      httpStatus: 503,
      cause,
    });
    this.recoveryWaitMs = recoveryWaitMs;
  }
}

/** One endpoint and the GGUF its `/props` says it loaded. */
export interface LlamaServerServedModel {
  url: string;
  modelPath: string;
}

/**
 * Every configured endpoint serves a model other than EMBEDDING_MODEL. A
 * configuration error, not an outage: waiting for an endpoint to come back
 * cannot fix it, so the embed call fails at once.
 */
export class LlamaServerModelMismatchError extends EmbeddingError {
  constructor(model: string, served: readonly LlamaServerServedModel[]) {
    const where = served.map((s) => `${s.url} serves ${s.modelPath}`).join("; ");
    super({
      code: "INFRA_LLAMA_SERVER_MODEL_MISMATCH",
      message: `No llama-server endpoint serves EMBEDDING_MODEL=${model}: ${where}`,
      hint:
        `Fetch the matching GGUF with: tea-rags llama-server fetch-model ${model} ` +
        `and print its launch line with: tea-rags llama-server command`,
      httpStatus: 409,
    });
  }
}

/**
 * llama-server answered with an HTTP error that is the request's fault, not the
 * endpoint's (bad request, wrong API key). Moving the request to another
 * endpoint would fail the same way, so it propagates.
 */
export class LlamaServerResponseError extends EmbeddingError {
  /** HTTP status; the embed quarantine keys on it (400/413/422 = bad input). */
  readonly responseStatus: number;
  readonly responseBody: string;

  constructor(url: string, status: number, body: string) {
    super({
      code: "INFRA_LLAMA_SERVER_RESPONSE_ERROR",
      message: `llama-server HTTP ${status} at ${url}: ${body}`,
      hint:
        status === 401 || status === 403
          ? `llama-server rejected the API key. Set EMBEDDING_API_KEY to the --api-key the server was started with.`
          : `llama-server returned an error (HTTP ${status}). Check the llama-server log on the host.`,
      httpStatus: status >= 500 ? 502 : status,
    });
    this.responseStatus = status;
    this.responseBody = body;
  }
}

/**
 * A single text does not fit the server's batch / context window. Halving
 * cannot help a one-text request, so the chunk itself is the problem.
 */
export class LlamaServerContextOverflowError extends LlamaServerResponseError {
  constructor(url: string, status: number, body: string) {
    super(url, status, body);
    Object.defineProperty(this, "code", { value: "INFRA_LLAMA_SERVER_CONTEXT_OVERFLOW" });
    Object.defineProperty(this, "hint", {
      value:
        `A code chunk does not fit the llama-server batch or context window.\n` +
        `Start the server with -b and -ub at least the model's context (tea-rags llama-server command prints 8192), ` +
        `or reduce INGEST_CHUNK_SIZE.`,
    });
  }
}
