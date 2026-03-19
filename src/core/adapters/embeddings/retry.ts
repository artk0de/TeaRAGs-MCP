/**
 * Shared rate-limit retry with exponential backoff for embedding providers.
 *
 * Handles the retry loop, delay calculation, and logging.
 * Each provider supplies its own rate-limit detection and optional Retry-After extraction.
 * On exhaustion or non-retryable error, rethrows the original error for provider-specific handling.
 */

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  isRetryable: (error: unknown) => boolean;
  /** Extract server-suggested retry delay in ms (e.g. from Retry-After header). */
  getRetryAfterMs?: (error: unknown) => number | undefined;
}

export async function withRateLimitRetry<T>(fn: () => Promise<T>, opts: RetryOptions, attempt = 0): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (opts.isRetryable(error) && attempt < opts.maxAttempts) {
      const retryAfterMs = opts.getRetryAfterMs?.(error);
      const delayMs = retryAfterMs ?? opts.baseDelayMs * Math.pow(2, attempt);
      console.error(
        `Rate limit reached. Retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${opts.maxAttempts})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return withRateLimitRetry(fn, opts, attempt + 1);
    }
    throw error;
  }
}
