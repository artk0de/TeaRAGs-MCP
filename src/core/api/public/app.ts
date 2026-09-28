/**
 * App — unified public API contract for tea-rags.
 *
 * Contains:
 * - App interface (the contract MCP/CLI consumers depend on)
 * - AppDeps interface (what bootstrap provides to create an App)
 * - createApp() factory (wires DI-provided handlers into an App)
 *
 * To add a new endpoint:
 * 1. Add DTO to public/dto/<domain>.ts
 * 2. Add method to App interface below
 * 3. Implement in internal/facades/ or internal/ops/
 * 4. Wire via internal/composition.ts (ops construction) + createApp() below
 * 5. Register MCP tool in src/mcp/tools/
 */

import type { GraphDbClientPool } from "../../adapters/duckdb/pool.js";
import type { EmbeddingProvider } from "../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../adapters/qdrant/client.js";
import type { EmbeddingModelGuard } from "../../adapters/qdrant/embedding-model-guard.js";
import type { Reranker } from "../../domains/explore/reranker.js";
import { formatIndexDriftReport, type IndexDriftReporter } from "../../domains/maintenance/drift/index.js";
import type { ProjectInfo } from "../../domains/maintenance/registry/index.js";
import type {
  CollectionOps,
  DocumentOps,
  ExploreFacade,
  GraphFacade,
  IngestFacade,
  NamingLexiconOps,
  OntologyReportOps,
  ProjectRegistryOps,
  TracePathOps,
} from "../index.js";
// The one facade-level internal reach this file keeps (bd tea-rags-mcp-0qaht.12):
// ops/schema construction lives in the composition root, and the handler
// TYPES arrive through the api barrel (`../index.js`), which already legally
// aggregates composition + facades. No deep `../internal/` path is imported.
import { composeAppOps, emptyArchitectureReport, emptyOntologyReport } from "../internal/composition.js";
import type {
  AddDocumentsRequest,
  CollectionInfo,
  CollectionMemoryMetrics,
  CreateCollectionRequest,
  DeleteDocumentsRequest,
  EnrichmentProgressCallback,
  ExploreCodeRequest,
  ExploreResponse,
  FindCyclesRequest,
  FindCyclesResponse,
  FindSimilarRequest,
  FindSymbolRequest,
  GetArchitectureReportRequest,
  GetArchitectureReportResponse,
  GetCalleesRequest,
  GetCalleesResponse,
  GetCallersRequest,
  GetCallersResponse,
  GetOntologyReportRequest,
  GetOntologyReportResponse,
  HybridSearchRequest,
  IndexMetrics,
  IndexOptions,
  IndexStats,
  IndexStatus,
  NamingLexiconRequest,
  NamingLexiconResult,
  PathTraceResult,
  PresetDescriptors,
  PresetDetail,
  ProgressCallback,
  ProjectRegistryAddress,
  RankChunksRequest,
  SemanticSearchRequest,
  TracePathRequest,
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
  indexCodebase: (
    path: string,
    options?: IndexOptions,
    progress?: ProgressCallback,
    enrichmentProgress?: EnrichmentProgressCallback,
  ) => Promise<IndexStats>;
  /**
   * Resolve once the current run's background enrichment has settled. The CLI
   * worker awaits this so its short-lived process outlives enrichment; the MCP
   * server (long-lived) never needs it.
   */
  whenEnrichmentComplete: () => Promise<void>;
  getIndexStatus: (path: string) => Promise<IndexStatus>;
  clearIndex: (path: string) => Promise<void>;

  // -- Collections (→ internal/ops/collection-ops.ts) --
  createCollection: (request: CreateCollectionRequest) => Promise<CollectionInfo>;
  listCollections: () => Promise<string[]>;
  getCollectionInfo: (name: string) => Promise<CollectionInfo>;
  /**
   * The server's memory/storage report for a collection or alias — disk, RAM
   * and page-cache bytes per component. Null when the server cannot report it
   * (Qdrant without the endpoint, missing collection, unreachable); never throws.
   */
  getCollectionMemory: (name: string) => Promise<CollectionMemoryMetrics | null>;
  deleteCollection: (name: string) => Promise<void>;

  // -- Documents (→ internal/ops/document-ops.ts) --
  addDocuments: (request: AddDocumentsRequest) => Promise<{ count: number }>;
  deleteDocuments: (request: DeleteDocumentsRequest) => Promise<{ count: number }>;

  // -- Index metrics (→ internal/facades/explore-facade.ts) --
  getIndexMetrics: (path: string) => Promise<IndexMetrics>;

  // -- Schema descriptors (→ Reranker via deps) --
  getSchemaDescriptors: () => PresetDescriptors;

  /**
   * Every drift axis the build can see, folded into ONE rendered report with
   * ONE `Run:` line (→ `IndexDriftReporter` via deps). Payload keys and
   * per-language code versions are disjoint conditions but share a remedy
   * lattice, so a reader who acts on the report repairs both in a single run
   * rather than reindexing twice. Null when nothing moved.
   *
   * `consume` has no default, on purpose: forgetting it would silently spend a
   * warning that belongs to someone else, so every caller states which it is.
   *
   * Nothing reaching this method consumes today. The once-per-report warning
   * belongs to the SEARCH path, which takes it from the reporter directly
   * (`ExploreOps#checkDrift`) so each distinct report rides exactly one
   * response per server session until an index run resets it. Both callers
   * here are inspections a reader runs on purpose — `get_index_status` and the
   * prime digest — and both pass `consume: false`: asking twice must report
   * twice, and neither may spend the search path's warning. `consume` decides
   * it on BOTH branches: a collection-addressed request is no more an
   * inspection than a path-addressed one.
   */
  checkIndexDrift: (req: { path?: string; collection?: string; consume: boolean }) => Promise<string | null>;

  // -- Project registry (→ internal/ops/project-registry-ops.ts) --
  registerProject: (input: {
    path: string;
    name: string;
  }) => Promise<{ collectionName: string; alreadyIndexed: boolean }>;
  listProjects: () => Promise<{ projects: ProjectInfo[] }>;
  unregisterProject: (input: ProjectRegistryAddress) => Promise<{ removed: boolean }>;

  // -- Codegraph (→ internal/facades/graph-facade.ts) --
  getCallers: (request: GetCallersRequest) => Promise<GetCallersResponse>;
  getCallees: (request: GetCalleesRequest) => Promise<GetCalleesResponse>;
  findCycles: (request: FindCyclesRequest) => Promise<FindCyclesResponse>;
  /** Architecture diagnostics (bd tea-rags-mcp-94hd9) — Stable Dependencies violations, root causes, exclusions. */
  getArchitectureReport: (request: GetArchitectureReportRequest) => Promise<GetArchitectureReportResponse>;
  tracePath: (request: TracePathRequest) => Promise<PathTraceResult>;
  /** Naming lexicon (bd tea-rags-mcp-4p3sb.12) — the project's names per type / callee / concept, verdicts on drafts. */
  getNamingLexicon: (request: NamingLexiconRequest) => Promise<NamingLexiconResult>;
  /** Naming ontology audit (bd tea-rags-mcp-4p3sb.20) — synonyms, homonyms, outliers, symbol collisions. */
  getOntologyReport: (request: GetOntologyReportRequest) => Promise<GetOntologyReportResponse>;

  // -- Provider availability — sync query used by MCP tool registrars to
  // skip registration when a required trajectory provider is not loaded.
  // Source of truth is the registered trajectory keys at composition time.
  hasProvider: (key: string) => boolean;
}

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface AppDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  ingest: IngestFacade;
  /**
   * Resolves the IngestFacade an index run of `path` must use — the one built
   * from THAT project's registry env rather than from the process env. Wired by
   * bootstrap (`ProjectIngestFactory`), which is the only layer that may parse
   * config. Omitted → every run uses the process-wide `ingest` facade.
   *
   * An MCP server is long-lived with a fixed process env, so this per-request
   * lookup is the only way a project's recorded tuning can govern a run; the
   * CLI seeds the same values into its forked worker's env instead. Returns a
   * facade rather than mutating env, so concurrent runs on different projects
   * cannot clobber each other (tea-rags-mcp-pmfm4).
   */
  ingestForPath?: (path: string) => IngestFacade;
  explore: ExploreFacade;
  reranker: Reranker;
  driftReporter: IndexDriftReporter;
  projectRegistryOps: ProjectRegistryOps;
  quantizationScalar: boolean;
  turboQuant: boolean;
  modelGuard?: EmbeddingModelGuard;
  /** Optional — present when CODEGRAPH_DISABLED is unset and DuckDB is wired. */
  graphFacade?: GraphFacade;
  /** Optional — present when codegraph is wired (built in bootstrap alongside graphFacade). */
  tracePathOps?: TracePathOps;
  /** Optional — present when codegraph is wired (built in bootstrap alongside tracePathOps). */
  namingLexiconOps?: NamingLexiconOps;
  /** Optional — present when codegraph is wired (built in bootstrap alongside graphFacade). */
  ontologyReportOps?: OntologyReportOps;
  /**
   * Collection/document CRUD handlers, pre-built by the api composition root
   * (`composeAppOps` in internal/composition.ts) and injected here. Omitted →
   * `createApp` composes them from the raw handles above (the bare-AppDeps
   * path tests use).
   */
  collectionOps?: CollectionOps;
  /** Same construction path as `collectionOps` — the pair shares one metadata-schema compiler. */
  documentOps?: DocumentOps;
  /**
   * Per-collection DuckDB pool — present when codegraph is wired.
   * CollectionOps uses it to delete the per-collection DuckDB file when
   * the Qdrant collection is dropped (clear / delete / force-reindex
   * paths). Omitted when codegraph is disabled — ops degrades to
   * Qdrant-only cleanup.
   */
  codegraphPool?: GraphDbClientPool;
  /**
   * Set of trajectory keys registered at composition time (from
   * `TrajectoryRegistry.getRegisteredKeys()`). Backs `App.hasProvider` —
   * MCP tool registrars consult it to skip registering tools whose
   * required provider is not loaded. Defaults to empty when omitted.
   */
  registeredProviderKeys?: ReadonlySet<string>;
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
 * wireOps — resolves the App-layer ops handlers and forwards the
 * pre-injected ProjectRegistryOps.
 *
 * Ops classes (CollectionOps, DocumentOps) own collection/document CRUD and
 * are constructed by the composition root (`composeAppOps` in
 * internal/composition.ts), arriving here via DI — which is why composition.ts
 * is the one facade-level internal module this file imports. The fallback
 * composes them from the raw infrastructure handles for callers that hand a
 * bare `AppDeps` (the test path). ProjectRegistryOps is supplied via deps
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
  if (deps.collectionOps && deps.documentOps) {
    return {
      collection: deps.collectionOps,
      document: deps.documentOps,
      projectRegistry: deps.projectRegistryOps,
    };
  }
  const composed = composeAppOps(deps);
  return {
    collection: deps.collectionOps ?? composed.collection,
    document: deps.documentOps ?? composed.document,
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

    // -- Indexing — delegate to IngestFacade. The index run resolves its facade
    // per path so the project's registry env governs it. Status does too: its
    // enrichment health is framed on the slice's provider list, which a
    // project's registry env can narrow (a disabled trajectory has no row), and
    // `get_index_metrics` frames on that same per-path slice
    // (bd tea-rags-mcp-uebug). Clear reads no composition and stays on the
    // process-wide facade.
    indexCodebase: async (path, options, progress, enrichmentProgress) =>
      (deps.ingestForPath?.(path) ?? facades.ingest).indexCodebase(path, options, progress, enrichmentProgress),
    whenEnrichmentComplete: async () => facades.ingest.whenEnrichmentComplete(),
    getIndexStatus: async (path) => (deps.ingestForPath?.(path) ?? facades.ingest).getIndexStatus(path),
    clearIndex: async (path) => facades.ingest.clearIndex(path),

    // -- Collections — delegate to CollectionOps --
    createCollection: async (req) => ops.collection.create(req),
    listCollections: async () => ops.collection.list(),
    getCollectionInfo: async (name) => ops.collection.getInfo(name),
    getCollectionMemory: async (name) => ops.collection.getMemory(name),
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
    checkIndexDrift: async ({ path, collection, consume }) => {
      const report = path
        ? consume
          ? await deps.driftReporter.checkAndConsume(path)
          : await deps.driftReporter.checkByPath(path)
        : collection
          ? consume
            ? deps.driftReporter.checkAndConsumeByCollectionName(collection)
            : deps.driftReporter.checkByCollectionName(collection)
          : null;
      return report && formatIndexDriftReport(report);
    },

    // -- Project registry — delegate to ProjectRegistryOps --
    registerProject: async (input) => ops.projectRegistry.register(input),
    listProjects: async () => ops.projectRegistry.list(),
    unregisterProject: async (input) => ops.projectRegistry.unregister(input),

    // -- Codegraph — getCallers/getCallees/findCycles delegate to GraphFacade;
    // tracePath delegates to TracePathOps. When the backing dep is undefined
    // (CODEGRAPH_DISABLED or DuckDB unavailable) surface an empty result
    // rather than crashing the tool.
    getCallers: async (req) => (deps.graphFacade ? deps.graphFacade.getCallers(req) : { callers: [] }),
    getCallees: async (req) => (deps.graphFacade ? deps.graphFacade.getCallees(req) : { callees: [] }),
    findCycles: async (req) => (deps.graphFacade ? deps.graphFacade.findCycles(req) : { cycles: [] }),
    getArchitectureReport: async (req) =>
      deps.graphFacade ? deps.graphFacade.getArchitectureReport(req) : emptyArchitectureReport(req),
    tracePath: async (req) => (deps.tracePathOps ? deps.tracePathOps.tracePath(req) : { paths: [], truncated: false }),
    getNamingLexicon: async (req) =>
      deps.namingLexiconOps ? deps.namingLexiconOps.getNamingLexicon(req) : { scope: "", byType: [], names: [] },
    getOntologyReport: async (req) =>
      deps.ontologyReportOps ? deps.ontologyReportOps.report(req) : emptyOntologyReport(req),

    // -- Provider availability — backs MCP tool-registrar gating. Source
    // of truth is `registeredProviderKeys` populated by composition from
    // `TrajectoryRegistry.getRegisteredKeys()`.
    hasProvider: (key) => (deps.registeredProviderKeys ?? EMPTY_PROVIDER_SET).has(key),
  };
}

/** Shared empty set so the default-fallback branch on every hasProvider call doesn't allocate. */
const EMPTY_PROVIDER_SET: ReadonlySet<string> = new Set();
