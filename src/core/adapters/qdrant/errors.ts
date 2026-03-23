/**
 * Qdrant adapter errors.
 */

import { InfraError } from "../errors.js";

export class QdrantUnavailableError extends InfraError {
  constructor(url: string, cause?: Error) {
    super({
      code: "INFRA_QDRANT_UNAVAILABLE",
      message: `Qdrant is not reachable at ${url}`,
      hint: `Start Qdrant: docker compose up -d, or verify QDRANT_URL=${url}`,
      httpStatus: 503,
      cause,
    });
  }
}

export class QdrantTimeoutError extends InfraError {
  constructor(url: string, operation: string, cause?: Error) {
    super({
      code: "INFRA_QDRANT_TIMEOUT",
      message: `Qdrant operation "${operation}" timed out at ${url}`,
      hint: `Check Qdrant health at ${url}/healthz and consider increasing timeout`,
      httpStatus: 504,
      cause,
    });
  }
}

export class AliasOperationError extends InfraError {
  constructor(operation: string, detail: string, cause?: Error) {
    super({
      code: "INFRA_ALIAS_OPERATION",
      message: `Alias operation "${operation}" failed: ${detail}`,
      hint: "Check Qdrant server status and collection names",
      httpStatus: 500,
      cause,
    });
  }
}

export class QdrantOperationError extends InfraError {
  constructor(operation: string, detail: string, cause?: Error) {
    super({
      code: "INFRA_QDRANT_OPERATION_FAILED",
      message: `Qdrant ${operation} failed: ${detail}`,
      hint: "Check Qdrant logs for details",
      httpStatus: 500,
      cause,
    });
  }
}

export class CollectionAlreadyExistsError extends InfraError {
  constructor(collectionName: string, cause?: Error) {
    super({
      code: "INFRA_COLLECTION_ALREADY_EXISTS",
      message: `Collection "${collectionName}" already exists`,
      hint:
        `Another session may be indexing into this collection. ` +
        `Wait for it to finish, or restart the MCP server to release stale locks. ` +
        `If the collection is orphaned, use clear_index to remove it.`,
      httpStatus: 409,
      cause,
    });
  }
}
