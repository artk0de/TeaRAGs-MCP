/**
 * Which enrichment failures belong to ONE provider and which end the run (bd
 * tea-rags-mcp-xvik1).
 *
 * A provider's own work — its repair dispatch, its finalize — failing is that
 * provider's outcome: it is marked failed (`FilePhase#markProviderFailed`) and
 * the other providers complete and write. Isolating it is the default because a
 * provider's dependency is its own: a codegraph daemon that cannot start is no
 * reason for git, which never touches it, to end `failed`.
 *
 * What no provider can survive stays fatal: the index itself is unreachable
 * (every provider writes its payload there) or the embedding endpoint is down.
 * Those errors are rethrown, never isolated.
 */

import { EmbeddingError } from "../../../../adapters/embeddings/errors.js";
import { isQdrantColdError } from "../../../../adapters/qdrant/errors.js";

export function isRunFatalEnrichmentError(error: unknown): boolean {
  return isQdrantColdError(error) || error instanceof EmbeddingError;
}
