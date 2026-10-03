/**
 * API barrel — unified entry point for all api/ exports.
 *
 * External consumers import from here. Internal structure is hidden.
 */

// Public surface (App contract + DTOs)
export { createApp } from "./public/app.js";
export type { App, AppDeps } from "./public/app.js";
export type {
  // Explore DTOs
  CollectionRef,
  TypedFilterParams,
  SemanticSearchRequest,
  HybridSearchRequest,
  RankChunksRequest,
  ExploreCodeRequest,
  SearchResult,
  ExploreResponse,
  SignalDescriptor,
  PresetDescriptors,
  // Ingest DTOs
  IndexOptions,
  IndexStats,
  IndexStatus,
  ChangeStats,
  ProgressCallback,
  // Collection DTOs
  CreateCollectionRequest,
  DocumentMetadataSchema,
  CollectionInfo,
  // Document DTOs
  AddDocumentsRequest,
  DeleteDocumentsRequest,
} from "./public/dto/index.js";

// Internal exports for bootstrap/MCP (not part of App contract)
export { SchemaBuilder } from "./internal/infra/schema-builder.js";
export { createComposition } from "./internal/composition.js";
export type { CompositionResult } from "./internal/composition.js";

// App-layer ops composition (bd tea-rags-mcp-0qaht.12): construction of the
// ops createApp delegates to, plus the codegraph-off empty-report builders,
// lives in the composition root. public/app.ts reaches them through the
// composition module; bootstrap constructs them here for DI.
export {
  composeAppOps,
  emptyArchitectureReport,
  emptyOntologyReport,
  emptyReviewChangesResult,
} from "./internal/composition.js";
export type { AppOpsComposition, AppOpsDeps } from "./internal/composition.js";

// Internal exports needed by bootstrap/factory.ts for DI wiring
export { ExploreFacade } from "./internal/facades/explore-facade.js";
export type { ExploreFacadeDeps } from "./internal/facades/explore-facade.js";
export { IngestFacade } from "./internal/facades/ingest-facade.js";
export type { IngestFacadeDeps } from "./internal/facades/ingest-facade.js";
export { GraphFacade } from "./internal/facades/graph-facade.js";
export type { GraphFacadeDeps } from "./internal/facades/graph-facade.js";
export { ReviewFacade, validateReviewChangesRequest } from "./internal/facades/review-facade.js";
export type { ReviewFacadeDeps } from "./internal/facades/review-facade.js";
// Ops/facade handler types AppDeps references — public/app.ts imports them
// from this barrel instead of deep internal paths. The four classes below are
// exported as runtime symbols (bootstrap constructs them), which carries the
// type side too; CollectionOps/DocumentOps are type-only here because their
// construction lives inside composeAppOps.
export type { CollectionOps } from "./internal/ops/collection-ops.js";
export type { DocumentOps } from "./internal/ops/document-ops.js";
export { NamingLexiconOps } from "./internal/ops/naming-lexicon-ops.js";
export { OntologyReportOps, ontologyLanguageProfiles } from "./internal/ops/ontology-report-ops.js";
export { ProjectRegistryOps } from "./internal/ops/project-registry-ops.js";
export { TracePathOps } from "./internal/ops/trace-path-ops.js";
export { WorktreeOps } from "./internal/ops/worktree-ops.js";
export { ReviewChangesOps } from "./internal/ops/review-changes-ops.js";
export type { ReviewChangesOpsDeps } from "./internal/ops/review-changes-ops.js";
export type { ReviewEdgeExtractionDeps } from "./internal/ops/review-edge-overlay.js";
export { createNamingReviewExtractor } from "./internal/ops/naming-review-extraction.js";
export { createPathCollectionResolver } from "./internal/collection-resolver.js";
export { readPayloadFileCommitCounts } from "./internal/infra/payload-file-commit-count-reader.js";
export { readPayloadImportSpecifiers } from "./internal/infra/payload-import-specifier-reader.js";
export {
  scheduleWorkingTreeGraphSweep,
  WORKING_TREE_GRAPH_BUILD_TIMEOUT_MS,
  WorkingTreeGraphCache,
  type WorkingTreeGraphCodegraphRuntime,
} from "./internal/infra/working-tree-graph-cache.js";
export { createWorkingTreeDeltaSignalSource } from "./internal/infra/working-tree-delta-signals.js";
export { createWorkingTreeGitSignalSource } from "./internal/infra/working-tree-git-signals.js";
export {
  createWorkingTreeGitSignalStore,
  scheduleWorkingTreeGitSignalSweep,
} from "./internal/infra/working-tree-git-signal-store.js";
export { InputValidationError, CollectionNotProvidedError } from "./errors.js";

// Project registry types re-exported from infra (public surface)
export type { CollectionEntry, ProjectInfo } from "../domains/maintenance/registry/index.js";
export { CollectionRegistry } from "../domains/maintenance/registry/index.js";
