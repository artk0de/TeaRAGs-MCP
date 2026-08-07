/**
 * Public API barrel — the SINGLE entry point for cli/ and mcp/ consumers.
 *
 * The dependency-direction guard
 * (`docs/superpowers/specs/2026-05-27-dependency-direction-guard-design.md`)
 * forbids cli/mcp from reaching below this file (no direct imports of
 * `contracts/`, `adapters/`, `infra/`, `api/internal/`, or `bootstrap/`).
 * Every consumer-facing symbol — runtime classes, error types, DTOs,
 * relocated contract types — is re-exported here from its internal layer of
 * origin.
 */

// ── App contract + factory ────────────────────────────────────────────
export { createApp } from "./app.js";
export type { App, AppDeps } from "./app.js";

// ── DTOs ─────────────────────────────────────────────────────────────
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
  EnrichmentProgressCallback,
  EnrichmentProgressEvent,
  // Collection DTOs
  CreateCollectionRequest,
  CollectionInfo,
  // Document DTOs
  AddDocumentsRequest,
  DeleteDocumentsRequest,
} from "./dto/index.js";

// ── Error classes — input validation hierarchy (api/errors.ts) ────────
export {
  InputValidationError,
  CollectionNotProvidedError,
  MissingArgumentError,
  InvalidParameterError,
  ProjectNotRegisteredError,
  ProjectNameNotUniqueError,
  ProjectNameInvalidError,
  PathDoesNotExistError,
  ProjectPathMissingError,
  StaleProjectAliasError,
} from "../errors.js";
export type { InputErrorCode } from "../errors.js";

// ── Error classes — foundation + config (infra/errors.ts) ─────────────
export {
  TeaRagsError,
  UnknownError,
  ConfigError,
  ConfigValueInvalidError,
  ConfigValueMissingError,
  ConfigNotInitializedError,
} from "../../infra/errors.js";
export type { ConfigErrorCode } from "../../infra/errors.js";

// ── Project registry — runtime + types (domains/maintenance/registry) ──
export { CollectionRegistry } from "../../domains/maintenance/registry/index.js";
export { PROJECT_NAME_RE } from "../../domains/maintenance/registry/index.js";
export { REGISTRY_ENV_ALLOWLIST, REGISTRY_ENV_GROUPS } from "../../domains/maintenance/registry/index.js";
export { pickRegistryEntry, replayRegistryEnv, resolveRegistryEnv } from "../../domains/maintenance/registry/index.js";
export type {
  CollectionEntry,
  ProjectInfo,
  RegistryEnvGroup,
  RegistryLookup,
} from "../../domains/maintenance/registry/index.js";

// ── Collection-name helpers (infra/collection-name.ts) ────────────────
export { resolveCollectionName, validatePath } from "../../infra/collection-name.js";

// ── Poison-pill quarantine — read surface for `doctor --quarantine` ───
export { QuarantineStore } from "../../domains/ingest/sync/index.js";
export type { QuarantineEntry } from "../../domains/ingest/sync/index.js";

// ── Relocated shared types (contracts/types/) ─────────────────────────
export type {
  EnrichmentHealthMap,
  EnrichmentProviderHealth,
  EnrichmentLevelHealth,
} from "../../contracts/types/enrichment.js";
export type { IngestCodeConfig } from "../../contracts/types/ingest-config.js";
export type {
  WorktreeCreateInput,
  WorktreeRemoveInput,
  WorktreeCreateResult,
  WorktreeInfo,
} from "../../contracts/types/worktree.js";

// ── Adapter-owned types/runtime consumed by cli ────────────────────
// Interfaces/classes stay in adapters; we re-export so cli reaches them via
// the public facade rather than importing core/adapters directly.
export type { EmbeddingProvider } from "../../adapters/embeddings/base.js";
export { QdrantManager } from "../../adapters/qdrant/client.js";
export { resolveQdrantUrl, EMBEDDED_MARKER } from "../../adapters/qdrant/embedded/daemon.js";
// Repo identity — lets the CLI tell that two paths are working trees of ONE
// repository (a checkout and its linked worktrees), so it can inherit config.
export { resolveGitCommonDir } from "../../adapters/vcs/git/common-dir.js";

// ── Payload signal descriptor (used by mcp schema-emitting code) ──────
export type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";

// ── Internal ops facade (cli/projects + cli/server) ───────────────────
// Exposing the class here keeps cli out of api/internal — the cli imports
// `ProjectRegistryOps` from `api/public`, which re-exports the implementation
// from `api/internal/ops/project-registry-ops.js`.
export { ProjectRegistryOps } from "../internal/ops/project-registry-ops.js";

// ── Worktree maintenance facade (cli/worktree, CLI-only — NOT on App/MCP) ──
// Same pattern as ProjectRegistryOps: the CLI instantiates `WorktreeOps` for
// commands and uses the registry-backed query helpers for list/info, all via
// `api/public` so cli stays out of api/internal and domains/maintenance.
export { WorktreeOps, toWorktreeInfo, listWorktreeInfos, worktreeInfoForPath } from "../internal/ops/worktree-ops.js";

// ── SchemaBuilder (used by mcp tool registration) ─────────────────────
// Concrete class lives in api/internal/infra; re-exporting through public
// keeps mcp from reaching into api/internal directly.
export { SchemaBuilder } from "../internal/infra/schema-builder.js";

// ── Index / enrichment runtime metrics (consumed by mcp formatters) ───
// Defined in core/types.ts (root) for now — relocation into contracts/types
// is tracked separately.
export type { EnrichmentMetrics, IndexingStatus } from "../../types.js";
