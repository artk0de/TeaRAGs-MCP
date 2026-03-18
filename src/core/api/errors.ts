/**
 * API-layer error classes — input validation errors thrown by facades.
 */

import type { ErrorCode } from "../contracts/errors.js";
import { TeaRagsError } from "../infra/errors.js";

/**
 * Abstract base for all input validation errors (httpStatus 400).
 * Facades throw these when request parameters are invalid.
 */
export abstract class InputValidationError extends TeaRagsError {
  constructor(opts: { code: ErrorCode; message: string; hint: string; httpStatus?: number; cause?: Error }) {
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
