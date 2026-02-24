/**
 * SearchFacade - Public API for semantic code search.
 *
 * Delegates to:
 * - SearchModule: semantic code search over indexed collections
 */

import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import { SearchModule } from "../search/search-module.js";
import type {
  CodeConfig,
  CodeSearchResult,
  SearchOptions,
} from "../types.js";

export class SearchFacade {
  private readonly search: SearchModule;

  constructor(
    qdrant: QdrantManager,
    embeddings: EmbeddingProvider,
    config: CodeConfig,
  ) {
    this.search = new SearchModule(qdrant, embeddings, config);
  }

  /** Search code semantically */
  async searchCode(path: string, query: string, options?: SearchOptions): Promise<CodeSearchResult[]> {
    return this.search.searchCode(path, query, options);
  }
}
