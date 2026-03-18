/**
 * Base error class and UnknownError — foundation for all TeaRags errors.
 */

import type { ErrorCode, TeaRagsErrorContract } from "../contracts/errors.js";

/**
 * Abstract base class for all TeaRags errors.
 *
 * Provides standardized formatting via `toUserMessage()` and `toString()`.
 * All domain errors extend this class.
 */
export abstract class TeaRagsError extends Error implements TeaRagsErrorContract {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly httpStatus: number;
  override readonly cause?: Error;

  constructor(opts: { code: ErrorCode; message: string; hint: string; httpStatus: number; cause?: Error }) {
    super(opts.message);
    this.name = this.constructor.name;
    this.code = opts.code;
    this.hint = opts.hint;
    this.httpStatus = opts.httpStatus;
    this.cause = opts.cause;
  }

  /**
   * Format for MCP tool responses (user-facing).
   * Subclasses may override for custom formatting.
   */
  toUserMessage(): string {
    return `[${this.code}] ${this.message}\n\nHint: ${this.hint}`;
  }

  /**
   * Format for logs and debugging.
   */
  override toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

/**
 * Wraps any unknown/unexpected error into the TeaRags error hierarchy.
 * Used by MCP middleware as a catch-all.
 */
export class UnknownError extends TeaRagsError {
  constructor(original: unknown) {
    const isError = original instanceof Error;
    super({
      code: "UNKNOWN_ERROR",
      message: isError ? original.message : typeof original === "string" ? original : "An unknown error occurred",
      hint: "Check server logs for details",
      httpStatus: 500,
      cause: isError ? original : undefined,
    });
  }
}
