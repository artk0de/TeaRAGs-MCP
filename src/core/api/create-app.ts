/**
 * createApp() — factory that assembles an App implementation from domain dependencies.
 *
 * Wires together ExploreFacade, IngestFacade, CollectionOps, DocumentOps,
 * Reranker (for schema descriptors), and SchemaDriftMonitor into a single
 * unified App object.
 */

import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import type { Reranker } from "../explore/reranker.js";
import type { App } from "./app.js";
import { CollectionOps } from "./collection-ops.js";
import { DocumentOps } from "./document-ops.js";
import type { ExploreFacade } from "./explore-facade.js";
import type { IngestFacade } from "./ingest-facade.js";
import type { SchemaDriftMonitor } from "./schema-drift-monitor.js";

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface AppDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  ingest: IngestFacade;
  explore: ExploreFacade;
  reranker: Reranker;
  schemaDriftMonitor: SchemaDriftMonitor;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createApp(deps: AppDeps): App {
  const collectionOps = new CollectionOps(deps.qdrant, deps.embeddings);
  const documentOps = new DocumentOps(deps.qdrant, deps.embeddings);

  return {
    // -- Search — delegate to ExploreFacade --
    semanticSearch: async (req) => deps.explore.semanticSearch(req),
    hybridSearch: async (req) => deps.explore.hybridSearch(req),
    rankChunks: async (req) => deps.explore.rankChunks(req),
    searchCode: async (req) => deps.explore.searchCodeTyped(req),

    // -- Indexing — delegate to IngestFacade --
    indexCodebase: async (path, options, progress) => deps.ingest.indexCodebase(path, options, progress),
    reindexChanges: async (path, progress) => deps.ingest.reindexChanges(path, progress),
    getIndexStatus: async (path) => deps.ingest.getIndexStatus(path),
    clearIndex: async (path) => deps.ingest.clearIndex(path),

    // -- Collections — delegate to CollectionOps --
    createCollection: async (req) => collectionOps.create(req),
    listCollections: async () => collectionOps.list(),
    getCollectionInfo: async (name) => collectionOps.getInfo(name),
    deleteCollection: async (name) => collectionOps.delete(name),

    // -- Documents — delegate to DocumentOps --
    addDocuments: async (req) => documentOps.add(req),
    deleteDocuments: async (req) => documentOps.delete(req),

    // -- Schema descriptors --
    getSchemaDescriptors: () => {
      const info = deps.reranker.getDescriptorInfo();
      const tools = ["semantic_search", "hybrid_search", "search_code", "rank_chunks"];
      const presetNames: Record<string, string[]> = {};
      for (const tool of tools) {
        presetNames[tool] = deps.reranker.getPresetNames(tool);
      }
      return {
        presetNames,
        signalDescriptors: info.map((d) => ({ name: d.name, description: d.description })),
      };
    },

    // -- Drift monitoring --
    checkSchemaDrift: async (ref) => {
      if ("path" in ref) return deps.schemaDriftMonitor.checkAndConsume(ref.path);
      return deps.schemaDriftMonitor.checkByCollectionName(ref.collection);
    },
  };
}
