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
  | "INPUT_PROJECT_PATH_ALREADY_REGISTERED"
  | "INPUT_PROJECT_NAME_INVALID"
  | "INPUT_PROJECT_PATH_MISSING"
  | "INPUT_PROJECT_ALIAS_STALE"
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
 * Thrown when a second alias is registered for a directory that another alias
 * already claims (bd tea-rags-mcp-dxa9w).
 *
 * One path, one entry: the registry is addressed by path everywhere a reader
 * resolves a collection, so two entries on one directory would split the
 * project's readers between them with nothing to say which is right.
 */
export class ProjectPathAlreadyRegisteredError extends InputValidationError {
  /**
   * `existing.name` is null for an entry nobody has aliased yet (a first index
   * before `register_project`, or a `recoverFromQdrant` stub). Its collection
   * name is NOT a usable alias, so the two states get different wording —
   * telling an operator to "use the existing alias 'code_9baaea35'" sends them
   * after a name that resolves nowhere.
   */
  constructor(path: string, existing: { name: string | null; collectionName: string }) {
    super({
      code: "INPUT_PROJECT_PATH_ALREADY_REGISTERED",
      message:
        existing.name !== null
          ? `Path '${path}' is already registered as '${existing.name}'`
          : `Path '${path}' is already registered under collection '${existing.collectionName}' (no alias)`,
      hint:
        existing.name !== null
          ? `Use the existing alias '${existing.name}', or unregister it first if you want a different name for this path.`
          : `Register collection '${existing.collectionName}' under a name, or unregister it, before pointing another alias at this directory.`,
      httpStatus: 409,
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

/**
 * Thrown when a project alias resolves to a non-empty path that no longer
 * exists on disk — typical case: the user registered an alias for a git
 * worktree, then later removed that worktree without unregistering. Without
 * this guard, callers operate silently on a phantom path (empty index,
 * orphan Qdrant collection, 0/0 indexing run) and read stale snapshots from
 * the surviving collection — see the bug report from 2026-05-28.
 *
 * Distinct from `ProjectPathMissingError` (path === "", recovered stub) on
 * purpose: stub entries never had a path; stale entries did and lost it.
 */
export class StaleProjectAliasError extends InputValidationError {
  constructor(name: string, stalePath: string) {
    super({
      code: "INPUT_PROJECT_ALIAS_STALE",
      message: `Project alias '${name}' points at '${stalePath}', which no longer exists on disk`,
      hint: `Unregister the stale alias (\`tea-rags unregister ${name}\`) or re-register it with a live path (\`tea-rags register --name ${name} --path <new-path>\`).`,
    });
  }
}
