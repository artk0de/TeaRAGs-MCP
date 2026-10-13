/**
 * Public API barrel — the CONTRACT surface for cli/ and mcp/ consumers.
 *
 * The dependency-direction guard
 * (`docs/superpowers/specs/2026-05-27-dependency-direction-guard-design.md`)
 * forbids cli/mcp from reaching below this file (no direct imports of
 * `contracts/`, `adapters/`, `infra/`, `api/internal/`, or `bootstrap/`).
 *
 * What this layer holds (bd tea-rags-mcp-89k7k.22): the contract and nothing
 * else — the `App` interface, DTOs, the input-error vocabulary
 * (`./errors.js`), pure render/predicate rules re-exported from `contracts/`,
 * and contract ports (`SchemaBuilderPort`). This file holds NO edge into
 * `api/internal/` — runtime or type-only: type-only edges ARE SDP-judged
 * (the component detector has no type-only flag; `domain-boundaries.md`
 * grants no `allowTypeImports` escape hatch — bd tea-rags-mcp-k7kmu C2,
 * pinned by `sdp-runtime-import-direction.test.ts`). The same holds for
 * DOMAINS: no runtime re-export from `domains/**` stays here either (k7kmu
 * C3) — registry env replay, `QuarantineStore`, the freshness check and the
 * seed render moved to the api root barrel or to `contracts/` (when pure),
 * so the stable layer holds no runtime edge into a domain, pinned by the
 * same test. RUNTIME classes and assembly functions (ops classes, the
 * path-collection resolver, `SchemaBuilder`, `createApp`, `reviewSectionIds`)
 * are reached through the api root barrel (`core/api/index.js`, the assembly
 * surface); deep `api/internal/` paths stay forbidden.
 */

// ── App contract ──────────────────────────────────────────────────────
// The FACTORY is not contract: `createApp` lives in the composition root
// (`api/internal/app-factory.ts`), re-exported through the api root barrel
// for bootstrap — the assembly surface (bd tea-rags-mcp-89k7k.22). So is its
// input: `AppDeps` names adapters and domain services and lives beside the
// factory (k7kmu C1). This barrel keeps the `App` interface only.
export type { App } from "./app.js";

// ── DTOs ─────────────────────────────────────────────────────────────
// The one runtime symbol among them: the recompute-path predicate both
// `IndexingOps#run` and the CLI index worker branch on.
export { ARCHITECTURE_PLANNED_EDGE_LIMIT, isEnrichmentRecompute } from "./dto/index.js";

// ── Codegraph resolve rate — miss definition + rendering rule ─────────
// `tea-rags prime` renders the per-receiver-kind rows of the resolve DTO with
// the same empty-denominator rule the chain-tally harness uses (bd qodqg).
export {
  EMPTY_RESOLVE_DENOMINATOR_MARKER,
  formatResolveRate,
  formatResolveRateCell,
  resolveRateMiss,
} from "../../contracts/resolve-rate.js";
export type { ResolveRateCell, ResolveRateCounts } from "../../contracts/resolve-rate.js";

// ── Codegraph payload vocabulary ─────────────────────────────────────
// The provider key the codegraph tool surface gates its registration on.
// Re-exported because mcp/ may not import contracts/ directly (dependency-
// direction guard), and the literal must exist in exactly one place.
export { CODEGRAPH_SYMBOLS_PROVIDER_KEY } from "../../contracts/codegraph-payload.js";
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
  PresetFilterNotice,
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
  DocumentMetadataSchema,
  CollectionInfo,
  CollectionMemoryBytes,
  CollectionMemoryMetrics,
  // Index metrics DTOs (get_index_metrics, prime)
  IndexMetrics,
  // Document DTOs
  AddDocumentsRequest,
  DeleteDocumentsRequest,
  // Registry DTOs
  ProjectRegistryAddress,
  StaleProjectEntry,
  StaleProjectPruneReport,
  // Architecture diagnostics DTOs
  ArchitectureRootCause,
  ArchitectureViolation,
  GetArchitectureReportRequest,
  GetArchitectureReportResponse,
  // Co-change partners DTOs (find_co_changed)
  CoChangeBuildProvenance,
  CoChangedFileResult,
  CoChangedPartner,
  FindCoChangedRequest,
  FindCoChangedResult,
  // Call-graph DTOs (get_callers, get_callees, trace_path, find_cycles)
  FindCyclesRequest,
  GetCalleesRequest,
  GetCallersRequest,
  TracePathRequest,
  // Naming lexicon DTOs
  NamingLexiconRequest,
  NamingLexiconResult,
  // Naming ontology audit DTOs
  GetOntologyReportRequest,
  GetOntologyReportResponse,
  OntologyReportSectionName,
  // Diff-scoped review DTOs (review_changes)
  ReviewChangesRequest,
  ReviewChangesResult,
  ReviewSectionId,
  ReviewSectionResult,
} from "./dto/index.js";

// ── Review sections — ids derived from the live provider registry ─────
// `App.reviewSectionIds()` is the MCP `sections` enum's single source (bd
// tea-rags-mcp-89k7k.1.4): a new section appears in the schema with no
// hand-edited union, and an id whose provider has not shipped is rejected at
// the boundary. Vended through the App (Uniform Access) since
// tea-rags-mcp-89k7k.22 — the barrel VALUE re-export this used to be was a
// stable→unstable edge onto the ops that derive it.

// ── Error classes — input validation hierarchy (public/errors.ts) ─────
// The exception vocabulary IS contract vocabulary (what an App method throws
// is part of its contract), which is why the classes live IN this layer
// (moved from api/errors.ts, bd tea-rags-mcp-89k7k.22): api/internal
// throwers import them from here — the stable direction.
export {
  InputValidationError,
  CollectionNotProvidedError,
  MissingArgumentError,
  InvalidParameterError,
  ProjectNotRegisteredError,
  ProjectNameNotUniqueError,
  ProjectEnvKeyUnknownError,
  ProjectNameInvalidError,
  ProjectPathAlreadyRegisteredError,
  PathDoesNotExistError,
  ProjectPathMissingError,
  StaleProjectAliasError,
  SubmoduleNotIndexedError,
  InvalidDocumentMetadataSchemaError,
  DocumentMetadataSchemaViolationError,
  UnknownArchitectureComponentError,
} from "./errors.js";
export type { InputErrorCode, DocumentMetadataViolation } from "./errors.js";

// ── Error classes — foundation + config (primitives/errors) ──────────
export {
  TeaRagsError,
  UnknownError,
  ConfigError,
  ConfigValueInvalidError,
  ConfigValueMissingError,
  ConfigNotInitializedError,
} from "../../primitives/errors/index.js";
export type { ConfigErrorCode } from "../../primitives/errors/index.js";

// ── Error classes — Qdrant adapter (adapters/qdrant/errors.ts) ────────
// `tea-rags qdrant recover` renders an optimizer error that survived the
// recreation (bd tea-rags-mcp-ye5o).
export { QdrantOptimizerErrorPersistsError } from "../../adapters/qdrant/errors.js";
// `prime` renders the warm-up placeholder only for a cold Qdrant and shows
// every other status failure as it is (bd tea-rags-mcp-zqg1i).
export { isQdrantColdError, QdrantUnavailableError } from "../../adapters/qdrant/errors.js";

// ── Project registry — types (contracts/types/registry.js) ──
// The registry RUNTIME (the CollectionRegistry class, the env replay/seed/
// backend-resolution functions) left this barrel for the api root barrel
// (bd tea-rags-mcp-k7kmu C3): a stable contract surface holds no runtime edge
// into a domain — the consumers are cli and bootstrap, which import
// `core/api/index.js` (the assembly surface). What stays here is contract
// vocabulary only: the types, and the pure alias regex.
export { PROJECT_NAME_RE } from "../../contracts/types/registry.js";
export type {
  AutoUpdateRunRecord,
  CollectionEntry,
  ProjectInfo,
  RegistryAutoUpdateConfig,
  RegistryEnvGroup,
  RegistryGitState,
  RegistryLookup,
  RegistryQdrantBackend,
  RegistryQdrantBackendClaim,
  // The registry vocabulary lives in contracts (bd tea-rags-mcp-0qaht.36):
  // this barrel is a stable surface and no longer reaches into the volatile
  // registry domain for types.
} from "../../contracts/types/registry.js";

// ── Repo git state helpers (infra) — CLI default-branch autodetect ────
export { detectDefaultBranch } from "../../adapters/vcs/index.js";

// ── Path canonicalization (adapters/filesystem/path-canonicalization.ts) ─
// `resolveCollectionName` is deliberately NOT here: a consumer that hashes a
// path bypasses the registry and addresses a collection a relocated project no
// longer uses (bd tea-rags-mcp-dxa9w). Consumers take the resolver below.
export { validatePath } from "../../adapters/filesystem/path-canonicalization.js";

// ── Path → collection, the one owner (api/internal/collection-resolver.ts) ──
// The resolver is runtime logic, not contract: `bootstrap` and `cli` reach the
// functions through the api root barrel, which re-exports them from
// api/internal (bd tea-rags-mcp-dxa9w, moved off this barrel by
// tea-rags-mcp-89k7k.22). The resolver TYPES are contract and come from
// `contracts/` — no edge into api/internal (bd tea-rags-mcp-k7kmu C2).
export type { PathCollectionResolver, ResolveInput } from "../../contracts/types/registry.js";

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
  WorktreeSeedCandidateRejection,
  WorktreeSeedReport,
  WorktreeSeedSourceRef,
} from "../../contracts/types/worktree.js";

// ── Adapter-owned types/runtime consumed by cli ────────────────────
// Interfaces/classes stay in adapters; we re-export so cli reaches them via
// the public facade rather than importing core/adapters directly.
export type { EmbeddingProvider } from "../../adapters/embeddings/base.js";
// GGUF weights from the Ollama registry — `tea-rags llama-server fetch-model`.
export {
  downloadVerifiedGguf,
  parseOllamaModelReference,
  resolveOllamaRegistryGguf,
  type OllamaRegistryGgufSource,
} from "../../adapters/embeddings/ollama-registry/gguf-source.js";
export { QdrantManager } from "../../adapters/qdrant/client.js";
// The one definition of "chunk points only" — every CLI chunk count passes it
// to countPoints so it agrees with get_index_status (bd tea-rags-mcp-39xca.16).
export { chunkPointsFilter } from "../../adapters/qdrant/service-points.js";
export { resolveQdrantUrl, EMBEDDED_MARKER } from "../../adapters/qdrant/embedded/daemon.js";
// Repo identity — lets the CLI tell that two paths are working trees of ONE
// repository (a checkout and its linked worktrees), so it can inherit config.
export { resolveGitCommonDir } from "../../adapters/vcs/index.js";

// ── Language capability ceilings (cli/prime per-index tier lines) ─────
// Static per-language descriptors, never measured numbers — prime pairs them
// with the realized resolve rate it already reads (bd tea-rags-mcp-xip6g).
// The resolver itself is an App method now (bd tea-rags-mcp-89k7k.9); only
// the type stays on this barrel.
export type { LanguageCapability } from "../../contracts/types/language.js";

// ── Payload signal descriptor (used by mcp schema-emitting code) ──────
export type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";

// ── Internal ops facades (cli/projects, cli/worktree) ─────────────────
// The ops CLASSES are runtime, not contract: cli constructs them through the
// api root barrel, which re-exports the implementations from
// `api/internal/ops/` (moved off this barrel by bd tea-rags-mcp-89k7k.22 —
// a VALUE re-export here was a stable→unstable edge with delta 0.87).
// ── Qdrant optimizer recovery (cli/qdrant recover; status surfaces print the command) ──
// The write path (`OptimizerRecoveryOps`) is assembly — root barrel only,
// type included (bd tea-rags-mcp-k7kmu C2). The
// failure predicate and the remedy's rendering rule are pure contract
// vocabulary and live in `contracts/optimizer-recovery.ts` (the `resolve-rate`
// precedent), re-exported here for both the CLI and MCP status surfaces (bd
// tea-rags-mcp-ye5o, tea-rags-mcp-89k7k.22).
export { isOptimizerFailure, renderOptimizerRecoveryCommand } from "../../contracts/optimizer-recovery.js";
export type { OptimizerRecoveryOutcome, OptimizerRecoveryTarget } from "../../contracts/optimizer-recovery.js";
// The one wording of a first index's worktree seed outcome — CLI status block
// and MCP `index_codebase` response both render it (bd tea-rags-mcp-k8gac).
// The rule is pure and lives in contracts (moved off the worktree domain by
// k7kmu C3, the `optimizer-recovery` precedent); the worktree facade
// re-exports it for the domain's consumers.
export { formatWorktreeSeedReport } from "../../contracts/worktree-seed-report.js";

// ── SchemaBuilderPort (used by mcp tool registration) ─────────────────
// mcp writes against the PORT; bootstrap constructs the internal
// `SchemaBuilder` class (which implements it) through the api root barrel and
// injects it (bd tea-rags-mcp-89k7k.22, tea-rags-mcp-k7kmu C2).
export type { RerankSchema, SchemaBuilderPort, ScoringWeightsSchema } from "./schema-builder-port.js";

// ── Auto-update trigger port (mcp search tools) ───────────────────────
// The seam bootstrap implements for the search tools' auto-update hint,
// moved here from `mcp/tools/explore.ts` so bootstrap's implementation and
// mcp's consumer both type against the stable contract layer (bd
// tea-rags-mcp-k7kmu C13). The runtime trigger stays in
// `bootstrap/auto-update/`.
export type { McpAutoUpdateTrigger } from "./auto-update-trigger.js";

// ── Index / enrichment runtime metrics (consumed by mcp formatters) ───
// Defined in core/types.ts (root) for now — relocation into contracts/types
// is tracked separately.
export type { EnrichmentMetrics, IndexingStatus } from "../../types.js";
