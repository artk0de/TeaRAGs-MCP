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
import type { EmbeddingModelGuard } from "../../infra/embedding-model-guard.js";
import type { ProjectInfo } from "../../infra/registry/index.js";
import type { SchemaDriftMonitor } from "../../infra/schema-drift-monitor.js";
import type { ExploreFacade } from "../internal/facades/explore-facade.js";
import type { IngestFacade } from "../internal/facades/ingest-facade.js";
import { CollectionOps } from "../internal/ops/collection-ops.js";
import { DocumentOps } from "../internal/ops/document-ops.js";
import type { ProjectRegistryOps } from "../internal/ops/project-registry-ops.js";
import type {
  AddDocumentsRequest,
  ChangeStats,
  CollectionInfo,
  CreateCollectionRequest,
  DeleteDocumentsRequest,
  ExploreCodeRequest,
  ExploreResponse,
  FindSimilarRequest,
  FindSymbolRequest,
  HybridSearchRequest,
  IndexMetrics,
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
  findSymbol: (request: FindSymbolRequest) => Promise<ExploreResponse>;

  // -- Indexing (→ internal/facades/ingest-facade.ts) --
  indexCodebase: (path: string, options?: IndexOptions, progress?: ProgressCallback) => Promise<IndexStats>;
  /** @deprecated Use indexCodebase — it auto-detects incremental reindex */
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

  // -- Index metrics (→ internal/facades/explore-facade.ts) --
  getIndexMetrics: (path: string) => Promise<IndexMetrics>;

  // -- Schema descriptors (→ Reranker via deps) --
  getSchemaDescriptors: () => PresetDescriptors;

  // -- Drift monitoring (→ SchemaDriftMonitor via deps) --
  checkSchemaDrift: (ref: { path: string } | { collection: string }) => Promise<string | null>;

  // -- Project registry (→ internal/ops/project-registry-ops.ts) --
  registerProject: (input: {
    path: string;
    name: string;
  }) => Promise<{ collectionName: string; alreadyIndexed: boolean }>;
  listProjects: () => Promise<{ projects: ProjectInfo[] }>;
  unregisterProject: (input: { name: string }) => Promise<{ removed: boolean }>;
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
  projectRegistryOps: ProjectRegistryOps;
  quantizationScalar: boolean;
  modelGuard?: EmbeddingModelGuard;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * wireFacades — returns the pre-assembled domain facades from deps.
 *
 * Facades (ExploreFacade, IngestFacade) are constructed upstream by
 * createComposition() in api/internal/composition.ts. createApp() does not
 * instantiate them — it only exposes them through the App interface. This
 * helper exists to make the facade-vs-ops layer split explicit at the
 * composition root: the App contract has two distinct groups of dependencies,
 * and each group has its own wire-up step.
 *
 * File-private — do NOT export.
 */
function wireFacades(deps: AppDeps): { explore: ExploreFacade; ingest: IngestFacade } {
  return { explore: deps.explore, ingest: deps.ingest };
}

/**
 * wireOps — instantiates the App-layer ops classes and forwards the
 * pre-injected ProjectRegistryOps.
 *
 * Ops classes (CollectionOps, DocumentOps) own collection/document CRUD and
 * are created here because they are App-layer wiring concerns — they do not
 * fit inside any domain facade. ProjectRegistryOps is supplied via deps
 * because its construction requires bootstrap-only state (the registry file
 * path).
 *
 * File-private — do NOT export.
 */
function wireOps(deps: AppDeps): {
  collection: CollectionOps;
  document: DocumentOps;
  projectRegistry: ProjectRegistryOps;
} {
  return {
    collection: new CollectionOps(deps.qdrant, deps.embeddings, deps.quantizationScalar, deps.modelGuard),
    document: new DocumentOps(deps.qdrant, deps.embeddings, deps.modelGuard),
    projectRegistry: deps.projectRegistryOps,
  };
}

export function createApp(deps: AppDeps): App {
  const facades = wireFacades(deps);
  const ops = wireOps(deps);

  return {
    // -- Search — delegate to ExploreFacade --
    semanticSearch: async (req) => facades.explore.semanticSearch(req),
    hybridSearch: async (req) => facades.explore.hybridSearch(req),
    rankChunks: async (req) => facades.explore.rankChunks(req),
    searchCode: async (req) => facades.explore.searchCode(req),
    findSimilar: async (req) => facades.explore.findSimilar(req),
    findSymbol: async (req) => facades.explore.findSymbol(req),

    // -- Indexing — delegate to IngestFacade --
    indexCodebase: async (path, options, progress) => facades.ingest.indexCodebase(path, options, progress),
    reindexChanges: async (path, progress) => facades.ingest.reindexChanges(path, progress),
    getIndexStatus: async (path) => facades.ingest.getIndexStatus(path),
    clearIndex: async (path) => facades.ingest.clearIndex(path),

    // -- Collections — delegate to CollectionOps --
    createCollection: async (req) => ops.collection.create(req),
    listCollections: async () => ops.collection.list(),
    getCollectionInfo: async (name) => ops.collection.getInfo(name),
    deleteCollection: async (name) => ops.collection.delete(name),

    // -- Documents — delegate to DocumentOps --
    addDocuments: async (req) => ops.document.add(req),
    deleteDocuments: async (req) => ops.document.delete(req),

    // -- Index metrics --
    getIndexMetrics: async (path) => facades.explore.getIndexMetrics(path),

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
        payloadSignals: deps.reranker.getPayloadSignals(),
      };
    },

    // -- Drift monitoring --
    checkSchemaDrift: async (ref) => {
      if ("path" in ref) return deps.schemaDriftMonitor.checkAndConsume(ref.path);
      return deps.schemaDriftMonitor.checkByCollectionName(ref.collection);
    },

    // -- Project registry — delegate to ProjectRegistryOps --
    registerProject: async (input) => ops.projectRegistry.register(input),
    listProjects: async () => ops.projectRegistry.list(),
    unregisterProject: async (input) => ops.projectRegistry.unregister(input),
  };
}
