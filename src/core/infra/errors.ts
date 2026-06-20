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
 * Configuration error codes. Thrown during bootstrap when config values are
 * invalid or missing; also raised by adapters/domains that re-validate config
 * at use time. Lives in `infra/` so every layer (bootstrap, adapters, domains,
 * api) can reach it without crossing a layer boundary.
 */
export type ConfigErrorCode = "CONFIG_VALUE_INVALID" | "CONFIG_VALUE_MISSING" | "CONFIG_NOT_INITIALIZED";

/** Abstract base for all configuration errors. Default httpStatus: 400 (client misconfiguration). */
export abstract class ConfigError extends TeaRagsError {
  constructor(opts: { code: ConfigErrorCode; message: string; hint: string; httpStatus?: number; cause?: Error }) {
    super({ ...opts, httpStatus: opts.httpStatus ?? 400 });
  }
}

/** Thrown when a configuration field has an invalid value. */
export class ConfigValueInvalidError extends ConfigError {
  constructor(field: string, value: string, expected: string) {
    super({
      code: "CONFIG_VALUE_INVALID",
      message: `Invalid value "${value}" for configuration field "${field}"`,
      hint: `Expected one of: ${expected}`,
      httpStatus: 400,
    });
  }
}

/** Thrown when a required configuration field is not set. */
export class ConfigValueMissingError extends ConfigError {
  constructor(field: string, envVar: string) {
    super({
      code: "CONFIG_VALUE_MISSING",
      message: `Required configuration field "${field}" is not set`,
      hint: `Set the ${envVar} environment variable`,
      httpStatus: 400,
    });
  }
}

/** Thrown when a config subsystem is accessed before initialization. */
export class ConfigNotInitializedError extends ConfigError {
  constructor(subsystem: string, initMethod: string) {
    super({
      code: "CONFIG_NOT_INITIALIZED",
      message: `Configuration subsystem "${subsystem}" is not initialized`,
      hint: `Call ${initMethod}() before accessing this configuration`,
      httpStatus: 500,
    });
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
      hint: "Check server logs for details. If this looks like a TeaRAGs bug, your agent can file a GitHub issue for you — run the tea-rags:report-issue skill.",
      httpStatus: 500,
      cause: isError ? original : undefined,
    });
  }
}
