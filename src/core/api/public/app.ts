/**
 * App — unified public API contract for tea-rags.
 *
 * The CONTRACT layer, nothing else (bd tea-rags-mcp-89k7k.22): this file holds
 * the `App` interface (what MCP/CLI consumers depend on) — type-only. The
 * factory that wires deps into an App, and `AppDeps` (what bootstrap provides
 * to create one, k7kmu C1), live in the composition root,
 * `api/internal/app-factory.ts`, re-exported through the api root barrel;
 * a runtime edge from this stable layer into the unstable assembly would put
 * the whole consumer surface in a dependency cycle with it.
 *
 * To add a new endpoint:
 * 1. Add DTO to public/dto/<domain>.ts
 * 2. Add method to the App interface below
 * 3. Implement in internal/facades/ or internal/ops/
 * 4. Wire via internal/composition.ts (ops construction) + createApp() in
 *    internal/app-factory.ts
 * 5. Register MCP tool in src/mcp/tools/
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import type { LanguageCapability } from "../../contracts/types/language.js";
import type {
  CollectionEntry,
  PathCollectionResolver,
  ProjectInfo,
  RegistryLookup,
} from "../../contracts/types/registry.js";
import type {
  AddDocumentsRequest,
  CollectionInfo,
  CollectionMemoryMetrics,
  CreateCollectionRequest,
  DeleteDocumentsRequest,
  EnrichmentProgressCallback,
  ExploreCodeRequest,
  ExploreResponse,
  FindCoChangedRequest,
  FindCoChangedResult,
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
  ProgressCallback,
  ProjectRegistryAddress,
  RankChunksRequest,
  ReviewChangesRequest,
  ReviewChangesResult,
  ReviewSectionId,
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
  /** Co-change partners (bd tea-rags-mcp-l1ot.1) — the temporal sub-graph: which files historically changed together. */
  findCoChanged: (request: FindCoChangedRequest) => Promise<FindCoChangedResult>;
  /**
   * Diff-scoped review (bd tea-rags-mcp-89k7k.1.4) — every report over ONE
   * working-tree change in one call, as sections keyed by id (naming,
   * incompleteChange, cohesion; architecture when its provider ships).
   */
  reviewChanges: (request: ReviewChangesRequest) => Promise<ReviewChangesResult>;
  /**
   * The registered review-section ids — the live section-provider registry (bd
   * tea-rags-mcp-89k7k.1.4), vended through the App (Uniform Access, bd
   * tea-rags-mcp-89k7k.22) so the MCP `sections` enum derives from the same
   * registry the orchestration reads, without a runtime edge from this
   * contract layer into the ops that derive it.
   */
  reviewSectionIds: () => readonly [ReviewSectionId, ...ReviewSectionId[]];

  // -- Domain runtime queries (Uniform Access, bd tea-rags-mcp-89k7k.9) --
  // The barrel no longer VALUE-re-exports these from their domains: the App
  // interface is the consumer surface, the implementations stay in their
  // domains, and the unstable edges live in the composition root / ops where
  // they belong on the main sequence.
  /**
   * Per-language capability descriptors — the native descriptor where
   * `domains/language` ships one, the unsupported-fallback descriptor
   * otherwise. Static ceilings, never measured numbers: `prime` pairs them
   * with the realized resolve rate it already reads (bd tea-rags-mcp-xip6g).
   */
  resolveLanguageCapabilities: (languages: readonly string[]) => Map<string, LanguageCapability>;
  /**
   * Whether a collection's build lease is live — the same predicate the orphan
   * report, the version cleanup and registry recovery honour (bd
   * tea-rags-mcp-9ovlp). The marker reader is caller-supplied: read-only CLI
   * paths hold their own Qdrant client rather than the App's.
   */
  isCollectionBuildInFlight: (
    qdrant: Pick<QdrantManager, "getPoint">,
    collection: string,
    options?: { deadWriterEvidenceUpTo?: number },
  ) => Promise<boolean>;
  /**
   * The registry entry whose index a read addressed by `path` alone is served
   * from — the rule the server resolves a request path by
   * (`resolveWorkingTree`): a linked worktree nobody registered reads its
   * repository's entry. Null when no entry claims the index. The registry is
   * caller-supplied, like the lease predicate's marker reader: the read-only
   * CLI paths hold their own (bd tea-rags-mcp-nkstp).
   *
   * @throws the path-validation errors for a bad `path`.
   */
  resolveBaseIndexEntry: (registry: RegistryLookup, path: string) => CollectionEntry | null;
  /**
   * The shared path→collection resolver (`createPathCollectionResolver`): the
   * entry that claims the path wins, the deterministic path hash — pinned to
   * the canonical spelling — is only its fallback (bd tea-rags-mcp-dxa9w).
   * Registry caller-supplied, same as {@link App.resolveBaseIndexEntry}.
   */
  createPathCollectionResolver: (registry: RegistryLookup) => PathCollectionResolver;

  // -- Provider availability — sync query used by MCP tool registrars to
  // skip registration when a required trajectory provider is not loaded.
  // Source of truth is the registered trajectory keys at composition time.
  hasProvider: (key: string) => boolean;
}
