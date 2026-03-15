/**
 * App — unified public API contract for tea-rags.
 *
 * Contains:
 * - App interface (the contract MCP/CLI consumers depend on)
 * - AppDeps interface (what bootstrap provides to create an App)
 * - createApp() factory (assembles internal classes into an App)
 *
 * To add a new endpoint:
 * 1. Add DTO to public/dto/<domain>.ts
 * 2. Add method to App interface below
 * 3. Implement in internal/facades/ or internal/ops/
 * 4. Wire in createApp() below — map App method to internal class
 * 5. Register MCP tool in src/mcp/tools/
 */

import type { EmbeddingProvider } from "../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../adapters/qdrant/client.js";
import type { Reranker } from "../../domains/explore/reranker.js";
import type { SchemaDriftMonitor } from "../../infra/schema-drift-monitor.js";
import type { ExploreFacade } from "../internal/facades/explore-facade.js";
import type { IngestFacade } from "../internal/facades/ingest-facade.js";
import { CollectionOps } from "../internal/ops/collection-ops.js";
import { DocumentOps } from "../internal/ops/document-ops.js";
import type {
  AddDocumentsRequest,
  ChangeStats,
  CollectionInfo,
  CreateCollectionRequest,
  DeleteDocumentsRequest,
  ExploreCodeRequest,
  ExploreResponse,
  FindSimilarRequest,
  HybridSearchRequest,
  IndexOptions,
  IndexStats,
  IndexStatus,
  PresetDescriptors,
  PresetDetail,
  ProgressCallback,
  RankChunksRequest,
  SemanticSearchRequest,
} from "./dto/index.js";

// ---------------------------------------------------------------------------
// App interface
// ---------------------------------------------------------------------------

export interface App {
  // -- Search (→ internal/facades/explore-facade.ts) --
  semanticSearch: (request: SemanticSearchRequest) => Promise<ExploreResponse>;
  hybridSearch: (request: HybridSearchRequest) => Promise<ExploreResponse>;
  rankChunks: (request: RankChunksRequest) => Promise<ExploreResponse>;
  searchCode: (request: ExploreCodeRequest) => Promise<ExploreResponse>;
  findSimilar: (request: FindSimilarRequest) => Promise<ExploreResponse>;

  // -- Indexing (→ internal/facades/ingest-facade.ts) --
  indexCodebase: (path: string, options?: IndexOptions, progress?: ProgressCallback) => Promise<IndexStats>;
  reindexChanges: (path: string, progress?: ProgressCallback) => Promise<ChangeStats>;
  getIndexStatus: (path: string) => Promise<IndexStatus>;
  clearIndex: (path: string) => Promise<void>;

  // -- Collections (→ internal/ops/collection-ops.ts) --
  createCollection: (request: CreateCollectionRequest) => Promise<CollectionInfo>;
  listCollections: () => Promise<string[]>;
  getCollectionInfo: (name: string) => Promise<CollectionInfo>;
  deleteCollection: (name: string) => Promise<void>;

  // -- Documents (→ internal/ops/document-ops.ts) --
  addDocuments: (request: AddDocumentsRequest) => Promise<{ count: number }>;
  deleteDocuments: (request: DeleteDocumentsRequest) => Promise<{ count: number }>;

  // -- Schema descriptors (→ Reranker via deps) --
  getSchemaDescriptors: () => PresetDescriptors;

  // -- Drift monitoring (→ SchemaDriftMonitor via deps) --
  checkSchemaDrift: (ref: { path: string } | { collection: string }) => Promise<string | null>;
}

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
    searchCode: async (req) => deps.explore.searchCode(req),
    findSimilar: async (req) => deps.explore.findSimilar(req),

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
      const tools = ["semantic_search", "hybrid_search", "search_code", "rank_chunks", "find_similar"];
      const presetNames: Record<string, string[]> = {};
      const presetDetails: Record<string, PresetDetail[]> = {};
      for (const tool of tools) {
        presetNames[tool] = deps.reranker.getPresetNames(tool);
        presetDetails[tool] = deps.reranker.getPresetDetails(tool);
      }
      return {
        presetNames,
        presetDetails,
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
