/**
 * Which embedding provider embeds on behalf of a collection (bd tea-rags-mcp-b91f5).
 *
 * A collection's vectors were written by ONE model, recorded in its project's
 * registry entry. Every text embedded to be compared against those vectors — a
 * query, a find_similar code example, a working-tree delta row — must go
 * through that same model, whatever the serving process was configured with.
 * The process config only supplies the default for a collection the registry
 * does not know.
 *
 * The guard travels with the provider: it compares the collection's marker
 * against the model of the provider that will embed for it, so a divergence
 * between the process config and the registry is never an error, while an index
 * built by a model other than its registry entry's still is.
 *
 * Implemented in bootstrap, the only layer that may turn a registry env into a
 * config and a config into a provider.
 */

import type { EmbeddingProvider } from "../../adapters/embeddings/base.js";
import type { EmbeddingModelGuard } from "../../adapters/qdrant/embedding-model-guard.js";

/** The provider that embeds for a collection, and the guard that holds the collection to its model. */
export interface CollectionEmbeddingBinding {
  readonly embeddings: EmbeddingProvider;
  readonly modelGuard: EmbeddingModelGuard;
}

/** What the caller of `CollectionEmbeddingsResolver#forCollection` is about to do. */
export interface CollectionEmbeddingsRequest {
  /**
   * The caller embeds (default). False for a caller that only checks the
   * model NAME (`rank_chunks`, `find_symbol`): it gets the binding without
   * waiting for the provider to prepare, so it never waits out model
   * discovery on a slow endpoint.
   */
  embeds?: boolean;
}

export interface CollectionEmbeddingsResolver {
  /** The binding that embeds on behalf of `collectionName` — ready to embed unless `embeds: false`. */
  forCollection: (collectionName: string, request?: CollectionEmbeddingsRequest) => Promise<CollectionEmbeddingBinding>;
}
