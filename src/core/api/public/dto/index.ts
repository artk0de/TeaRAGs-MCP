/**
 * DTO barrel — re-exports all domain DTOs.
 */

export type { CollectionIdentifier } from "./common.js";

export type {
  // Explore
  CollectionRef,
  TypedFilterParams,
  SemanticSearchRequest,
  HybridSearchRequest,
  RankChunksRequest,
  ExploreCodeRequest,
  FindSimilarRequest,
  FindSymbolRequest,
  SearchResult,
  ExploreResponse,
  PresetFilterNotice,
  SignalDescriptor,
  PresetDetail,
  PresetDescriptors,
} from "./explore.js";

export { isEnrichmentRecompute } from "./ingest.js";

export type {
  // Ingest
  IndexOptions,
  IndexCodebaseInput,
  IndexStats,
  IndexStatus,
  ChangeStats,
  ProgressCallback,
  EnrichmentProgressCallback,
  EnrichmentProgressEvent,
} from "./ingest.js";

export type {
  // Collection
  CreateCollectionRequest,
  DocumentMetadataSchema,
  CollectionInfo,
  CollectionMemoryBytes,
  CollectionMemoryMetrics,
} from "./collection.js";

export type {
  // Document
  AddDocumentsRequest,
  DeleteDocumentsRequest,
} from "./document.js";

export type { IndexMetrics, SignalMetrics } from "./metrics.js";

export type {
  // Registry
  StaleProjectEntry,
  StaleProjectPruneReport,
} from "./registry.js";

export type {
  // Codegraph
  AmbiguousCallerResult,
  CalleeResult,
  CallerResult,
  CycleMemberLocation,
  CycleResult,
  FileImportersResponse,
  FileImportResult,
  FileImportsResponse,
  FindCyclesRequest,
  FindCyclesResponse,
  GetCalleesRequest,
  GetCalleesResponse,
  GetCallersRequest,
  GetCallersResponse,
  SymbolCalleesResponse,
  SymbolCallersResponse,
  // trace_path
  TracePathRequest,
  PathStep,
  TracedPath,
  PathTraceResult,
} from "./graph.js";

export type {
  // Architecture diagnostics (get_architecture_report)
  ArchitectureDirectoryRelation,
  ArchitectureReportSummary,
  ArchitectureRootCause,
  ArchitectureViolation,
  ConventionPrivacyArchitectureViolation,
  ConventionPrivacyRule,
  ConventionPrivacyViolationEvidence,
  FacadeLeakArchitectureViolation,
  FacadeLeakKind,
  FacadeLeakViolationEvidence,
  FacadeModuleExclusionReason,
  FacadeModuleSummary,
  GetArchitectureReportRequest,
  GetArchitectureReportResponse,
  LeakingAbstractionArchitectureRootCause,
  LeakingAbstractionArchitectureViolation,
  LeakingAbstractionReportSummary,
  StableDependenciesExclusionSummary,
  StableDependenciesReportSummary,
  StableDependencyArchitectureRootCause,
  StableDependencyArchitectureViolation,
  StableDependencyViolationEvidence,
} from "./architecture.js";

export { projectSearchResultPayloads } from "./payload-projection.js";
export type { PayloadProjectionOutcome } from "./payload-projection.js";

export { stripInternalFields } from "./sanitize.js";
