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

export { isEnrichmentRecompute, rechunkSelectorOf } from "./ingest.js";

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

export type { WorkingTreeFloor, WorkingTreeIndexTarget, WorkingTreeMarker, WorkingTreeState } from "./working-tree.js";

export type {
  // Registry
  ProjectRegistryAddress,
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
  // Co-change partners (find_co_changed)
  CoChangeBuildProvenance,
  CoChangedFileResult,
  CoChangedPartner,
  FindCoChangedRequest,
  FindCoChangedResult,
} from "./cochange.js";

// Architecture diagnostics (get_architecture_report) — wholesale, for the
// same reason `architecture.js` itself re-exports the finding contract with a
// wildcard: a new detector shape is added ONCE in the contract
// (bd tea-rags-mcp-0e4vf) and reaches consumers without an edit here. The
// hand-listed mirror this line replaced made the barrel co-change with the
// boundary-diagnostics vocabulary on every detector landing
// (bd tea-rags-mcp-89k7k.25).
export type * from "./architecture.js";

export type {
  // Naming lexicon (get_naming_lexicon)
  NamingLexiconCalleeEntry,
  NamingLexiconDraftName,
  NamingLexiconEvidenceScope,
  NamingLexiconEvidenceSource,
  NamingLexiconGenericName,
  NamingLexiconKindProfile,
  NamingLexiconNameCount,
  NamingLexiconNameEvidence,
  NamingLexiconNameVerdict,
  NamingLexiconRequest,
  NamingLexiconResult,
  NamingLexiconTypeDraft,
  NamingLexiconTypeEntry,
  NamingLexiconTypeNameHead,
  NamingReviewFinding,
  NamingReviewNotJudgedEntry,
  NamingReviewNotJudgedReason,
  NamingReviewNote,
  NamingReviewResult,
} from "./naming-lexicon.js";

export type {
  // Naming ontology audit (get_ontology_report)
  GetOntologyReportRequest,
  GetOntologyReportResponse,
  OntologyCollision,
  OntologyCollisionRule,
  OntologyEvidence,
  OntologyHomonym,
  OntologyLocation,
  OntologyNameCount,
  OntologyNamingShape,
  OntologyOutlier,
  OntologyReportSectionName,
  OntologyReportSummary,
  OntologySynonym,
  OntologyValueKind,
} from "./ontology.js";

export type {
  // Diff-scoped review (review_changes)
  CohesionSectionPayload,
  CohesionSectionResult,
  IncompleteChangePartner,
  IncompleteChangePartnerKind,
  IncompleteChangeSectionPayload,
  IncompleteChangeSectionResult,
  NamingSectionResult,
  ReviewChangesRequest,
  ReviewChangesResult,
  ReviewChangesReviewBlock,
  ReviewSectionEnvelope,
  ReviewSectionId,
  ReviewSectionNotJudgedEntry,
  ReviewSectionResult,
} from "./review.js";

export { projectSearchResultPayloads } from "./payload-projection.js";
export type { PayloadProjectionOutcome } from "./payload-projection.js";

export { stripInternalFields } from "./sanitize.js";
