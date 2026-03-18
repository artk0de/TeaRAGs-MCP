/**
 * Explore domain errors — search, hybrid, query validation.
 */

import type { ErrorCode } from "../../contracts/errors.js";
import { TeaRagsError } from "../../infra/errors.js";

/**
 * Abstract base for all explore domain errors.
 * Default httpStatus: 400.
 */
export abstract class ExploreError extends TeaRagsError {
  constructor(opts: { code: ErrorCode; message: string; hint: string; httpStatus?: number; cause?: Error }) {
    super({ ...opts, httpStatus: opts.httpStatus ?? 400 });
  }
}

/** The requested collection does not exist in Qdrant. */
export class CollectionNotFoundError extends ExploreError {
  constructor(collectionName: string) {
    super({
      code: "EXPLORE_COLLECTION_NOT_FOUND",
      message: `Collection "${collectionName}" not found`,
      hint: "Run index_codebase first to create and populate the collection",
      httpStatus: 404,
    });
  }
}

/** Hybrid search was attempted on a collection without sparse vectors. */
export class HybridNotEnabledError extends ExploreError {
  constructor(collectionName: string) {
    super({
      code: "EXPLORE_HYBRID_NOT_ENABLED",
      message: `Collection "${collectionName}" does not have hybrid search enabled`,
      hint: "Create a new collection with enableHybrid set to true",
      httpStatus: 400,
    });
  }
}

/** The search query is invalid (empty, too long, etc.). */
export class InvalidQueryError extends ExploreError {
  constructor(reason: string) {
    super({
      code: "EXPLORE_INVALID_QUERY",
      message: `Invalid query: ${reason}`,
      hint: "Provide a non-empty search query",
      httpStatus: 400,
    });
  }
}

/** Unknown search strategy type requested. */
export class InvalidStrategyError extends ExploreError {
  constructor(type: string) {
    super({
      code: "EXPLORE_INVALID_STRATEGY",
      message: `Unknown search strategy type: ${type}`,
      hint: "Use one of: vector, hybrid, scroll-rank",
      httpStatus: 400,
    });
  }
}
