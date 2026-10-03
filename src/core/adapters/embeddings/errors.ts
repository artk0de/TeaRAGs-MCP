/**
 * Abstract base for all embedding provider errors.
 */

import { InfraError } from "../errors.js";

/**
 * Abstract base class for embedding provider errors.
 * All provider-specific errors (Ollama, ONNX, OpenAI, etc.) extend this.
 */
export abstract class EmbeddingError extends InfraError {}

/**
 * The provider could not be reached at all — no endpoint answered within the
 * call's recovery budget. Every provider's "unreachable" error extends this, so
 * a caller can tell an OUTAGE (a search may degrade around it) from a request
 * the provider rejected, without knowing which provider is configured.
 */
export abstract class EmbeddingProviderUnavailableError extends EmbeddingError {}

/** True when `error` says the embedding provider is unreachable (see {@link EmbeddingProviderUnavailableError}). */
export function isEmbeddingProviderUnavailable(error: unknown): error is EmbeddingProviderUnavailableError {
  return error instanceof EmbeddingProviderUnavailableError;
}

/**
 * Collection was indexed with a different embedding model than currently configured.
 * Vectors from different models are incompatible — search results will be incorrect.
 *
 * `hint` is overridable because the default one assumes the NAMES differ: its
 * first option is "point EMBEDDING_MODEL back at <expected>". When the guard
 * catches a model that kept its name and changed its weights, expected equals
 * what the config already says, and that option is a no-op — the caller passes
 * the advice that actually applies.
 */
export class EmbeddingModelMismatchError extends EmbeddingError {
  constructor(expected: string, actual: string, hint?: string) {
    super({
      code: "INFRA_EMBEDDING_MODEL_MISMATCH",
      message: `Embedding model mismatch: collection indexed with "${expected}", current config uses "${actual}"`,
      hint:
        hint ??
        `Either:\n` +
          `1. Fix EMBEDDING_MODEL in config to "${expected}"\n` +
          `2. Force re-index: index_codebase with forceReindex=true`,
      httpStatus: 409,
    });
  }
}

/**
 * Carried by a provider-unavailable error whose provider can wait for its host
 * to come back (EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS) before giving up.
 * `recoveryWaitMs` is the wall-clock time that wait already took; 0 when the
 * provider gave up at once.
 */
export interface ProviderRecoveryWaitReporting {
  readonly recoveryWaitMs: number;
}

/**
 * True when the provider gave up only after waiting its recovery budget out:
 * the host is down, and the next embed restarts that same wait. A caller about
 * to embed again must fail with this error instead — a retry on top of a spent
 * wait multiplies the operator's budget (bd tea-rags-mcp-umatc).
 */
export function isProviderRecoveryWaitSpent(error: unknown): error is EmbeddingError & ProviderRecoveryWaitReporting {
  if (!(error instanceof EmbeddingError)) return false;
  const { recoveryWaitMs } = error as Partial<ProviderRecoveryWaitReporting>;
  return typeof recoveryWaitMs === "number" && recoveryWaitMs > 0;
}
