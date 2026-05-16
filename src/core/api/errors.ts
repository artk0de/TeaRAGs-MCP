/**
 * API-layer error classes — input validation errors thrown by facades.
 */

import { TeaRagsError } from "../infra/errors.js";

/**
 * Input validation error codes. Local strict union — used by InputValidationError
 * subclasses. Aggregates into the runtime ErrorCode = string contract.
 */
export type InputErrorCode =
  | "INPUT_COLLECTION_NOT_PROVIDED"
  | "INPUT_MISSING_ARGUMENT"
  | "INPUT_INVALID_PARAMETER"
  | "INPUT_PROJECT_NOT_REGISTERED"
  | "INPUT_PROJECT_NAME_NOT_UNIQUE"
  | "INPUT_PROJECT_NAME_INVALID"
  | "INPUT_PROJECT_PATH_MISSING"
  | "INPUT_PATH_NOT_EXISTS";

/**
 * Abstract base for all input validation errors (httpStatus 400).
 * Facades throw these when request parameters are invalid.
 */
export abstract class InputValidationError extends TeaRagsError {
  constructor(opts: { code: InputErrorCode; message: string; hint: string; httpStatus?: number; cause?: Error }) {
    super({
      ...opts,
      httpStatus: opts.httpStatus ?? 400,
    });
  }
}

/**
 * Thrown when neither 'collection' nor 'path' is provided in a request.
 */
export class CollectionNotProvidedError extends InputValidationError {
  constructor() {
    super({
      code: "INPUT_COLLECTION_NOT_PROVIDED",
      message: "Either 'collection' or 'path' parameter is required.",
      hint: "Provide a 'collection' name or a 'path' to the codebase.",
    });
  }
}

/**
 * Thrown when required arguments are missing from a request.
 */
export class MissingArgumentError extends InputValidationError {
  constructor(args: string[]) {
    super({
      code: "INPUT_MISSING_ARGUMENT",
      message: `Missing required arguments: ${args.join(", ")}`,
      hint: "Provide all required arguments",
    });
  }
}

/**
 * Thrown when a parameter has an invalid value.
 */
export class InvalidParameterError extends InputValidationError {
  constructor(parameter: string, detail: string) {
    super({
      code: "INPUT_INVALID_PARAMETER",
      message: `Invalid parameter "${parameter}": ${detail}`,
      hint: "Check the parameter value and try again",
    });
  }
}

/**
 * Thrown when a request references a project name that is not present in the registry.
 */
export class ProjectNotRegisteredError extends InputValidationError {
  constructor(name: string, available: string[]) {
    const list = available.length > 0 ? available.join(", ") : "(none)";
    super({
      code: "INPUT_PROJECT_NOT_REGISTERED",
      message: `Project '${name}' is not registered. Available: ${list}`,
      hint: "Register the project via index_codebase, or pick a name from the available list.",
    });
  }
}

/**
 * Thrown when a project name collides with an already-registered collection.
 */
export class ProjectNameNotUniqueError extends InputValidationError {
  constructor(name: string, existingCollectionName: string) {
    super({
      code: "INPUT_PROJECT_NAME_NOT_UNIQUE",
      message: `Project name '${name}' is not unique — already used by '${existingCollectionName}'`,
      hint: "Choose a different name or remove the existing project.",
    });
  }
}

/**
 * Thrown when a project name violates the naming contract.
 *
 * @param reason - "regex" (invalid characters), "tooLong", or "empty"
 */
export class ProjectNameInvalidError extends InputValidationError {
  constructor(name: string, reason: "regex" | "tooLong" | "empty") {
    const reasonPhrase = ProjectNameInvalidError.reasonToPhrase(reason);
    super({
      code: "INPUT_PROJECT_NAME_INVALID",
      message: `Project name '${name}' is invalid: ${reasonPhrase}`,
      hint: "Names must be non-empty, within length limits, and match the allowed character set.",
    });
  }

  private static reasonToPhrase(reason: "regex" | "tooLong" | "empty"): string {
    switch (reason) {
      case "regex":
        return "contains invalid characters";
      case "tooLong":
        return "exceeds maximum length";
      case "empty":
        return "is empty";
    }
  }
}

/**
 * Thrown when a request provides a filesystem path that does not exist.
 */
export class PathDoesNotExistError extends InputValidationError {
  constructor(path: string) {
    super({
      code: "INPUT_PATH_NOT_EXISTS",
      message: `Path '${path}' does not exist`,
      hint: "Provide an absolute path to an existing directory.",
    });
  }
}

/**
 * Thrown when a registry entry was recovered (e.g. via `tea-rags doctor
 * --recover-registry`) but its `path` is empty, so commands that rely on the
 * alias to resolve a filesystem location cannot proceed. The hint carries
 * the exact shell command the user should run to re-register the project.
 */
export class ProjectPathMissingError extends InputValidationError {
  constructor(name: string, hint: string) {
    super({
      code: "INPUT_PROJECT_PATH_MISSING",
      message: `Project '${name}' has no path stored — re-register it before using as an alias`,
      hint,
    });
  }
}
