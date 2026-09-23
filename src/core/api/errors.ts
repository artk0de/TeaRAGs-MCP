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
  | "INPUT_PATH_NOT_EXISTS"
  | "INPUT_INVALID_DOCUMENT_METADATA_SCHEMA"
  | "INPUT_DOCUMENT_METADATA_SCHEMA_VIOLATION";

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

/**
 * Thrown by `create_collection` when its `schema` cannot serve as a document
 * metadata schema — the top level does not describe an object, or the JSON
 * Schema does not compile. Raised before the collection is created, so a
 * rejected schema never leaves an untyped collection behind.
 */
export class InvalidDocumentMetadataSchemaError extends InputValidationError {
  constructor(detail: string, cause?: Error) {
    super({
      code: "INPUT_INVALID_DOCUMENT_METADATA_SCHEMA",
      message: `Invalid document metadata schema: ${detail}`,
      hint: 'Pass a JSON Schema whose top level is { "type": "object", "properties": { ... } } — it validates each document\'s metadata.',
      cause,
    });
  }
}

/** One schema violation inside an `add_documents` batch. */
export interface DocumentMetadataViolation {
  /** Position of the document in the request's `documents` array. */
  documentIndex: number;
  documentId: string | number;
  /** Dotted path inside `metadata`; empty for a violation on the object itself (e.g. unknown keys). */
  field: string;
  /** Zod's description of what the schema expected. */
  expected: string;
  /** The value found at `field`; `undefined` when the field is absent. */
  received: unknown;
}

const MAX_REPORTED_VIOLATIONS = 10;

/**
 * Thrown by `add_documents` on a typed collection when any document's metadata
 * violates the collection schema. The batch is all-or-nothing: nothing is
 * embedded or stored. `violations` lists every violation across the batch; the
 * message names the first ten.
 */
export class DocumentMetadataSchemaViolationError extends InputValidationError {
  readonly violations: DocumentMetadataViolation[];

  constructor(collection: string, violations: DocumentMetadataViolation[]) {
    const lines = violations.slice(0, MAX_REPORTED_VIOLATIONS).map(describeViolation);
    const rest = violations.length - lines.length;
    if (rest > 0) lines.push(`… and ${rest} more`);
    super({
      code: "INPUT_DOCUMENT_METADATA_SCHEMA_VIOLATION",
      message:
        `${violations.length} metadata violation(s) against the schema of collection "${collection}"; ` +
        `no document was added: ${lines.join("; ")}`,
      hint: "Fix the listed metadata fields and resend the whole batch. get_collection_info shows the collection schema.",
    });
    this.violations = violations;
  }
}

function describeViolation(v: DocumentMetadataViolation): string {
  const where = `documents[${v.documentIndex}] (id ${JSON.stringify(v.documentId)})`;
  const field = v.field === "" ? "metadata" : `metadata.${v.field}`;
  const got = v.received === undefined ? "" : ` (got ${JSON.stringify(v.received)})`;
  return `${where} ${field}: ${v.expected}${got}`;
}
