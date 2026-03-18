/**
 * Trajectory domain errors — git, static analysis.
 *
 * Re-exports subdomain errors for convenience.
 */

import type { ErrorCode } from "../../contracts/errors.js";
import { TeaRagsError } from "../../infra/errors.js";

/**
 * Abstract base for all trajectory domain errors.
 * Default httpStatus: 500.
 */
export abstract class TrajectoryError extends TeaRagsError {
  constructor(opts: { code: ErrorCode; message: string; hint: string; httpStatus?: number; cause?: Error }) {
    super({ ...opts, httpStatus: opts.httpStatus ?? 500 });
  }
}

/**
 * Abstract base for git trajectory errors.
 * Default httpStatus: 500.
 */
export abstract class TrajectoryGitError extends TrajectoryError {}

/**
 * Abstract base for static trajectory errors.
 * Default httpStatus: 500.
 */
export abstract class TrajectoryStaticError extends TrajectoryError {}

/** Git blame failed for a specific file. */
export class GitBlameFailedError extends TrajectoryGitError {
  constructor(file: string, cause?: Error) {
    super({
      code: "TRAJECTORY_GIT_BLAME_FAILED",
      message: `Git blame failed for "${file}"`,
      hint: "Ensure the file is tracked by git and the repository is not corrupted",
      cause,
    });
  }
}

/** Git log timed out after the specified duration. */
export class GitLogTimeoutError extends TrajectoryGitError {
  constructor(timeoutMs: number, cause?: Error) {
    super({
      code: "TRAJECTORY_GIT_LOG_TIMEOUT",
      message: `Git log timed out after ${timeoutMs}ms`,
      hint: "Try reducing the scope of the operation or increasing the timeout",
      httpStatus: 504,
      cause,
    });
  }
}

/** Git CLI is not available on the system. */
export class GitNotAvailableError extends TrajectoryGitError {
  constructor(cause?: Error) {
    super({
      code: "TRAJECTORY_GIT_NOT_AVAILABLE",
      message: "Git is not available",
      hint: "Ensure git is installed and accessible in PATH",
      httpStatus: 503,
      cause,
    });
  }
}

/** Static analysis (tree-sitter) parsing failed for a file. */
export class StaticParseFailedError extends TrajectoryStaticError {
  constructor(file: string, cause?: Error) {
    super({
      code: "TRAJECTORY_STATIC_PARSE_FAILED",
      message: `Failed to parse "${file}"`,
      hint: "The file may contain syntax errors or use an unsupported language",
      cause,
    });
  }
}
