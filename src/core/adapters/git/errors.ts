/**
 * Git CLI adapter errors.
 */

import { InfraError } from "../errors.js";

export class GitCliNotFoundError extends InfraError {
  constructor() {
    super({
      code: "INFRA_GIT_CLI_NOT_FOUND",
      message: "Git CLI is not installed or not in PATH",
      hint: "Install git: https://git-scm.com/downloads",
      httpStatus: 503,
    });
  }
}

export class GitCliTimeoutError extends InfraError {
  constructor(command: string, timeoutMs: number, cause?: Error) {
    super({
      code: "INFRA_GIT_CLI_TIMEOUT",
      message: `Git command "${command}" timed out after ${timeoutMs}ms`,
      hint: "The repository may be too large, or git is unresponsive",
      httpStatus: 504,
      cause,
    });
  }
}
