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
  CollectionInfo,
  // Document DTOs
  AddDocumentsRequest,
  DeleteDocumentsRequest,
} from "./public/dto/index.js";

// Internal exports for bootstrap/MCP (not part of App contract)
export { SchemaBuilder } from "./internal/infra/schema-builder.js";
export { createComposition } from "./internal/composition.js";
export type { CompositionResult } from "./internal/composition.js";

// Internal exports needed by bootstrap/factory.ts for DI wiring
export { ExploreFacade } from "./internal/facades/explore-facade.js";
export type { ExploreFacadeDeps } from "./internal/facades/explore-facade.js";
export { IngestFacade } from "./internal/facades/ingest-facade.js";
export type { IngestFacadeDeps } from "./internal/facades/ingest-facade.js";
export { InputValidationError, CollectionNotProvidedError } from "./errors.js";
