/**
 * Composition root — assembles the full application graph from trajectories.
 *
 * Uses TrajectoryRegistry to aggregate payloadSignals, derivedSignals,
 * filters, and presets from all registered trajectories. The only place
 * that knows which trajectories exist.
 */

import type { GraphDbClientPool } from "../../adapters/duckdb/pool.js";
import type { EmbeddingProvider } from "../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../adapters/qdrant/client.js";
import type { EmbeddingModelGuard } from "../../adapters/qdrant/embedding-model-guard.js";
import {
  payloadFieldIndexSchema,
  SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS,
  type PayloadFieldIndexSchema,
} from "../../adapters/qdrant/schema-manager.js";
import { CODEGRAPH_SYMBOLS_PROVIDER_KEY } from "../../contracts/index.js";
import { toPhysicalPayloadKey } from "../../contracts/signal-utils.js";
import type { TemporalSymbolCommitBuffer } from "../../contracts/types/codegraph.js";
import type { FilterPresetDef } from "../../contracts/types/filter-preset.js";
import type {
  IdentifierNamingConvention,
  LanguageCodeVersions,
  LanguageFactoryDescriptor,
} from "../../contracts/types/language.js";
import type {
  EnrichmentProvider,
  FilterDescriptor,
  WorkerEnrichmentDescriptor,
} from "../../contracts/types/provider.js";
import type { ChunkSetBumpScopes } from "../../contracts/types/rechunk.js";
import type { DerivedSignalDescriptor, RerankPreset } from "../../contracts/types/reranker.js";
import type { StatsAccumulatorDescriptor } from "../../contracts/types/stats-accumulator.js";
import type { PayloadSignalDescriptor, SignalFloors } from "../../contracts/types/trajectory.js";
import { OrderByFieldResolver } from "../../domains/explore/rank-module.js";
import { resolvePresets } from "../../domains/explore/rerank/presets/index.js";
import { Reranker } from "../../domains/explore/reranker.js";
import { validateSignalDependencies } from "../../domains/ingest/infra/collection-stats.js";
import { resolveChunkSetBumpScopes, resolveLanguageCodeVersions } from "../../domains/language/capability/versions.js";
import { LanguageFactory } from "../../domains/language/index.js";
import type { DeclaredPayloadIndexSet } from "../../domains/maintenance/migration/payload_index_migrations/index.js";
import { createCodegraphTrajectories, type CodegraphDeps } from "../../domains/trajectory/codegraph/index.js";
import { CODEGRAPH_FILTER_PRESETS } from "../../domains/trajectory/codegraph/symbols/filter-presets/index.js";
import {
  CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  CODEGRAPH_SYMBOLS_FILE_SIGNALS,
  codegraphFilters,
} from "../../domains/trajectory/codegraph/symbols/index.js";
import { CODEGRAPH_SYMBOLS_DERIVED_SIGNALS } from "../../domains/trajectory/codegraph/symbols/rerank/derived-signals/index.js";
import {
  ALL_COMPOSITE_FILTER_PRESETS,
  buildCompositeFilterPresets,
} from "../../domains/trajectory/composite/filter-presets/index.js";
import { buildCompositePresets } from "../../domains/trajectory/composite/presets/index.js";
import { filterPayloadKeys } from "../../domains/trajectory/filter-payload-keys.js";
import { GitTrajectory } from "../../domains/trajectory/git.js";
import {
  GIT_FILTER_PRESETS,
  gitDerivedSignals,
  gitFilters,
  gitPayloadSignalDescriptors,
  gitStatsAccumulators,
} from "../../domains/trajectory/git/index.js";
import type { SquashOptions } from "../../domains/trajectory/git/infra/metrics.js";
import type { GitProviderConfig } from "../../domains/trajectory/git/provider.js";
import { TrajectoryRegistry } from "../../domains/trajectory/index.js";
import { STATIC_FILTER_PRESETS } from "../../domains/trajectory/static/filter-presets/index.js";
import { StaticTrajectory } from "../../domains/trajectory/static/index.js";
import { staticStatsAccumulators } from "../../domains/trajectory/static/stats/index.js";
import type { GetArchitectureReportRequest, GetArchitectureReportResponse } from "../public/dto/architecture.js";
import type { FindCoChangedRequest, FindCoChangedResult } from "../public/dto/cochange.js";
import type { GetOntologyReportRequest, GetOntologyReportResponse } from "../public/dto/ontology.js";
import type { ReviewChangesRequest, ReviewChangesResult } from "../public/dto/review.js";
import { ArchitectureReportOps } from "./ops/architecture-report-ops.js";
import { CochangeOps } from "./ops/cochange-ops.js";
import { CollectionOps } from "./ops/collection-ops.js";
import { DocumentMetadataSchemaCompiler } from "./ops/document-metadata-schema.js";
import { DocumentOps } from "./ops/document-ops.js";
import { OntologyReportOps } from "./ops/ontology-report-ops.js";
import { ReviewChangesOps } from "./ops/review-changes-ops.js";

export interface CompositionResult {
  registry: TrajectoryRegistry;
  reranker: Reranker;
  allPayloadSignalDescriptors: PayloadSignalDescriptor[];
  allDerivedSignals: DerivedSignalDescriptor[];
  allStatsAccumulators: StatsAccumulatorDescriptor[];
  resolvedPresets: RerankPreset[];
  /**
   * Real `LanguageFactoryDescriptor` — all languages are native `domains/language/<lang>`
   * providers built by the factory itself (the legacy per-language adapter was
   * removed by tea-rags-mcp-jh40 once every vertical migrated). Injected into the
   * codegraph provider (walker + resolver capabilities). The chunker worker is a
   * SECOND composition root that builds its own factory (functions can't cross
   * the worker boundary).
   */
  languageFactory: LanguageFactoryDescriptor;
  /**
   * Per-language structural-signal floors, resolved once from the language
   * factory. Handed to every consumer that turns percentiles into labels —
   * the reranker's overlay and `IndexMetricsQuery`'s labelMap — so neither has
   * to reach into `domains/language` itself.
   */
  signalFloors: Map<string, SignalFloors>;
  /**
   * Per-language code versions of THIS build (bd tea-rags-mcp-frwka) — the
   * grammar each language parses with plus its hand-bumped chunking / walker /
   * codegraph-schema revisions. Resolved once here for the same reason
   * `signalFloors` is: the composition root is the only layer allowed to bridge
   * `domains/language`, and both consumers sit outside it — the ingest path
   * stamps it onto the registry entry, the maintenance monitor compares it.
   */
  languageCodeVersions: Map<string, LanguageCodeVersions>;
  /**
   * Declared scope of each chunk-set bump, per language plus `*`
   * (bd tea-rags-mcp-j4oww). The drift monitor renders the minimal scoped
   * `--force` from it; the indexing run decides from the SAME map which stamps a
   * scoped force may advance.
   */
  languageChunkSetBumpScopes: Map<string, ChunkSetBumpScopes>;
  /**
   * `LanguageCapability.naming` per language that declares one (bd
   * tea-rags-mcp-4p3sb.12) — the casing per identifier role and the
   * non-concept types the naming lexicon reads. Resolved here for the same
   * reason as `signalFloors`: the lexicon's ops must not reach into
   * `domains/language`.
   */
  namingConventions: Map<string, IdentifierNamingConvention>;
}

export interface CompositionOptions {
  /**
   * Git trajectory provider configuration. The GitEnrichmentProvider is
   * constructed inside GitTrajectory at composition time so the registry's
   * `getAllEnrichmentProviders()` returns a fully-configured provider —
   * IngestFacade consumes the registry list directly (no inline
   * construction). When omitted, GitTrajectory wires with default config.
   */
  git?: {
    config?: Partial<GitProviderConfig>;
    squashOpts?: SquashOptions;
    /**
     * Worker-pool descriptor built by the bootstrap composition root (which
     * alone knows the absolute compiled-JS worker module path). When present,
     * the GitEnrichmentProvider surfaces it so `WorkerPoolEnrichmentExecutor`
     * dispatches git blame off-thread instead of inline. Omitted in tests ⇒
     * inline-only (graceful fallback). bd tea-rags-mcp-dz7f.
     */
    workerDescriptor?: WorkerEnrichmentDescriptor;
    /**
     * Run-scoped main-thread buffer absorbing per-symbol commit sets during
     * the chunk walk (bd tea-rags-mcp-3gz4f). The composition root must pass
     * the SAME instance here and to `codegraph.temporalSymbolCommits` — the
     * git provider fills it, the temporal completion hook drains it.
     */
    temporalSymbolCommits?: TemporalSymbolCommitBuffer;
  };
  /**
   * When provided, registers the codegraph L1 family (Slice 1: Symbols).
   * Bootstrap supplies these deps when `CODEGRAPH_ENABLED` is true; tests
   * pass them directly. Omitting opts the family out — the rest of the
   * composition is unaffected.
   */
  codegraph?: CodegraphDeps;
}

/**
 * Assemble the gated filter-preset catalog for a composition.
 *
 * Static presets are always-on. Git presets gate on the "git" key;
 * codegraph presets gate on "codegraph.symbols". Composite presets gate
 * via `buildCompositeFilterPresets`, which drops any preset whose
 * `requires` references a non-registered trajectory key. Mirrors the
 * rerank-preset gating done by `buildCompositePresets`.
 */
export function assembleFilterPresets(registeredKeys: ReadonlySet<string>): FilterPresetDef[] {
  return [
    ...STATIC_FILTER_PRESETS,
    ...(registeredKeys.has("git") ? GIT_FILTER_PRESETS : []),
    ...(registeredKeys.has(CODEGRAPH_SYMBOLS_PROVIDER_KEY) ? CODEGRAPH_FILTER_PRESETS : []),
    ...buildCompositeFilterPresets(registeredKeys),
  ];
}

/**
 * Every payload signal descriptor any trajectory of THIS BUILD declares — the
 * full registry, regardless of which trajectories this process registers.
 *
 * `createComposition` registers codegraph only when its deps are supplied
 * (`CODEGRAPH_ENABLED`), so `allPayloadSignalDescriptors` answers "what this
 * process reads", not "what the index may carry". Judging a stored payload
 * index by the former would make a codegraph-off run treat codegraph's keys as
 * orphans; schema-v16 judges by this instead (bd tea-rags-mcp-q34ic).
 *
 * A trajectory added to `createComposition` must be added here too —
 * `tests/core/api/composition-full-registry-payload-signals.test.ts` fails
 * until it is.
 */
export function fullRegistryPayloadSignalDescriptors(): PayloadSignalDescriptor[] {
  return [
    ...new StaticTrajectory().payloadSignals,
    ...gitPayloadSignalDescriptors,
    ...CODEGRAPH_SYMBOLS_FILE_SIGNALS,
    ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  ];
}

/**
 * Every stats accumulator any trajectory of THIS BUILD declares — the companion
 * of `fullRegistryPayloadSignalDescriptors`, for the same reason.
 *
 * Accumulators are what fill `distributions`: language and chunk-type counts,
 * the distinct-path set behind `totalFiles`, author tallies, the git time
 * range. Recomputing stats without them does not fail — it silently yields a
 * stats file whose `perLanguage` map is EMPTY, because the per-language share
 * gate divides by a language count that nothing produced.
 *
 * A trajectory added to `createComposition` must be added here too —
 * `tests/core/api/composition-full-registry-stats-accumulators.test.ts` fails
 * until it is.
 */
/**
 * Every derived signal any trajectory of THIS BUILD declares — the companion
 * of `fullRegistryPayloadSignalDescriptors`, for the same reason: the payload
 * indexes rank_chunks orders by must not depend on the flags of the process
 * that decides them.
 *
 * A trajectory added to `createComposition` must be added here too —
 * `tests/core/api/composition-declared-payload-indexes.test.ts` fails until it is.
 */
export function fullRegistryDerivedSignals(): DerivedSignalDescriptor[] {
  return [...new StaticTrajectory().derivedSignals, ...gitDerivedSignals, ...CODEGRAPH_SYMBOLS_DERIVED_SIGNALS];
}

/**
 * The payload index set this build declares (bd tea-rags-mcp-mimq0), consumed by
 * the `payloadIndexes` reconcile on every reindex sweep and by `initializeSchema`
 * for a new collection.
 *
 * REQUIRED = the schema pipeline's own indexes ∪ every physical path rank_chunks
 * can order by, resolved by the rule a query uses (`OrderByFieldResolver`) over
 * the full registry, ∪ every physical key a typed filter or a filter preset can
 * condition on (bd tea-rags-mcp-18xh5), learned by running those builders
 * (`filterPayloadKeys`) — each with the schema `payloadFieldIndexSchema` gives
 * it, the same schema `ScrollRankStrategy` creates lazily. A filter key no
 * payload signal descriptor names (`git.file.recentDominantAuthorEmail`, the
 * email arm of `recentAuthor`) takes the type of the value its condition
 * matches; a range over such a key has no safe schema and is left out. KNOWN =
 * the physical key of every full-registry payload signal: an index there is
 * legitimate even when nothing requires it (the set schema-v16 judged against).
 */
export function declaredPayloadIndexSet(): DeclaredPayloadIndexSet {
  const signals = fullRegistryPayloadSignalDescriptors();
  const types = new Map(signals.map((descriptor) => [toPhysicalPayloadKey(descriptor.key), descriptor.type] as const));

  const required = new Map<string, PayloadFieldIndexSchema>();
  const declare = (path: string, type: PayloadSignalDescriptor["type"] | undefined): void => {
    const schema = type === undefined ? undefined : payloadFieldIndexSchema(path, type);
    if (schema && !required.has(path)) required.set(path, schema);
  };
  for (const key of SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS) {
    // A managed key's schema never depends on the declared type.
    declare(key, "number");
  }
  for (const path of new OrderByFieldResolver(fullRegistryDerivedSignals(), signals).allOrderByPaths()) {
    declare(path, types.get(path));
  }
  for (const [path, matchedType] of filterPayloadKeys(fullRegistryFilters(), fullRegistryFilterPresets())) {
    declare(path, types.get(path) ?? matchedType);
  }

  return { required, known: new Set(types.keys()) };
}

/**
 * Every typed filter any trajectory of THIS BUILD declares — the companion of
 * `fullRegistryPayloadSignalDescriptors`: the filter keys a collection needs
 * indexed must not depend on the flags of the process that decides them.
 *
 * A trajectory added to `createComposition` must be added here too —
 * `tests/core/api/composition-declared-payload-indexes.test.ts` fails until it is.
 */
export function fullRegistryFilters(): FilterDescriptor[] {
  return [...new StaticTrajectory().filters, ...gitFilters, ...codegraphFilters];
}

/**
 * Every filter preset of THIS BUILD, ungated — `assembleFilterPresets` with
 * every trajectory registered. Same reason and same parity test as
 * `fullRegistryFilters`.
 */
export function fullRegistryFilterPresets(): FilterPresetDef[] {
  return [
    ...STATIC_FILTER_PRESETS,
    ...GIT_FILTER_PRESETS,
    ...CODEGRAPH_FILTER_PRESETS,
    ...ALL_COMPOSITE_FILTER_PRESETS,
  ];
}

export function fullRegistryStatsAccumulators(): StatsAccumulatorDescriptor[] {
  return [...staticStatsAccumulators, ...gitStatsAccumulators];
}

export function createComposition(options: CompositionOptions = {}): CompositionResult {
  // Real LanguageFactoryDescriptor: it ENCAPSULATES construction. All languages are
  // native `domains/language/<lang>` providers built by the factory itself; each
  // native provider carries its own resolver, built with the configured
  // ambiguous-resolve mode (threaded via CodegraphDeps). Built before the
  // codegraph trajectory so it can be injected into the codegraph provider.
  const languageFactory = new LanguageFactory({
    ambiguousResolveMode: options.codegraph?.ambiguousResolveMode,
  });

  const registry = new TrajectoryRegistry();
  registry.register(new StaticTrajectory());
  registry.register(
    new GitTrajectory(
      options.git?.config,
      options.git?.squashOpts,
      options.git?.workerDescriptor,
      options.git?.temporalSymbolCommits,
    ),
  );
  if (options.codegraph) {
    for (const trajectory of createCodegraphTrajectories({ ...options.codegraph, languageFactory })) {
      registry.register(trajectory);
    }
  }

  // Assemble + gate the filter-preset catalog by registered trajectory
  // keys, then load it into the registry (pure data owner). Done before
  // Reranker construction and before validateSignalDependencies so the
  // validation sees the REAL filter presets alongside the real descriptors.
  const filterPresets = assembleFilterPresets(new Set(registry.getRegisteredKeys()));
  registry.setFilterPresets(filterPresets);

  const allPayloadSignalDescriptors = registry.getAllPayloadSignalDescriptors();
  // Fail-loud at composition time: if any descriptor's confidence block
  // references a percentile that the support signal doesn't declare
  // (neither stats.labels nor stats.percentilesToCompute), this throws.
  // The filter presets are validated too — a filter preset referencing a
  // pN that the descriptor doesn't declare throws here. Prevents silent
  // fallback in production. See `validateSignalDependencies` for details.
  validateSignalDependencies(allPayloadSignalDescriptors, filterPresets);
  const allDerivedSignals = registry.getAllDerivedSignals();
  const allStatsAccumulators = registry.getAllStatsAccumulators();
  // Trajectory presets come from the registry (one trajectory per preset);
  // composite presets cross trajectories (e.g. blastRadius weights
  // codegraph.fanIn + git.churn) and live in their own namespace under
  // `domains/trajectory/composite/presets/`. The resolver merges by
  // (name, tools[i]) and the composite list wins, so composites override
  // trajectory presets of the same name without modifying them in place.
  // Gating: buildCompositePresets filters each composite against the
  // registered trajectory keys — a composite whose `requires` references
  // a non-registered trajectory is silently dropped.
  const compositePresets = buildCompositePresets(new Set(registry.getRegisteredKeys()));
  const resolvedPresets = resolvePresets(registry.getAllPresets(), compositePresets);
  // Per-language structural floors. The composition root is the only layer
  // allowed to bridge `domains/language` into `domains/explore` — the explore
  // domain receives the resolved map, exactly as it receives descriptors and
  // presets, and never imports the language domain itself.
  const signalFloors = languageFactory.signalFloors();
  const reranker = new Reranker(allDerivedSignals, resolvedPresets, allPayloadSignalDescriptors, signalFloors);
  // Passthrough the registered filter-preset names so the MCP schema layer
  // (SchemaBuilder) can surface them through its single Reranker dependency.
  reranker.setFilterPresetNames(registry.filterPresetNames());
  // Same passthrough for the typed filter params the registry applies — the
  // schema layer exposes only these, so a trajectory that is not registered
  // (codegraph off) contributes no dead params (bd tea-rags-mcp-86wsz).
  reranker.setFilterParamNames(registry.getAllFilters().map((f) => f.param));

  return {
    registry,
    reranker,
    allPayloadSignalDescriptors,
    allDerivedSignals,
    allStatsAccumulators,
    resolvedPresets,
    languageFactory,
    signalFloors,
    languageCodeVersions: resolveLanguageCodeVersions(languageFactory.capabilities()),
    languageChunkSetBumpScopes: resolveChunkSetBumpScopes(languageFactory.capabilities()),
    namingConventions: new Map(
      [...languageFactory.capabilities()].flatMap(([language, capability]) =>
        capability.naming ? [[language, capability.naming] as const] : [],
      ),
    ),
  };
}

/**
 * `EnrichmentProvider.algorithmVersion` per provider key, for the providers a
 * slice actually enriches with (bd tea-rags-mcp-xi2r9). One derivation for both
 * consumers: the ingest slice stamps it, the trajectory-version drift monitor
 * compares against it — two derivations could disagree on which providers count.
 */
export function enrichmentAlgorithmVersions(providers: readonly EnrichmentProvider[]): Map<string, number> {
  const versions = new Map<string, number>();
  for (const provider of providers) {
    if (provider.algorithmVersion !== undefined) versions.set(provider.key, provider.algorithmVersion);
  }
  return versions;
}

// ---------------------------------------------------------------------------
// App-layer ops composition (bd tea-rags-mcp-0qaht.12)
// ---------------------------------------------------------------------------

/**
 * Infrastructure handles the App-layer ops wrap. A structural subset of
 * `AppDeps`: `createApp` hands its whole deps object here on the fallback
 * path, and bootstrap passes the same handles explicitly on the DI path.
 */
export interface AppOpsDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  quantizationScalar: boolean;
  turboQuant: boolean;
  modelGuard?: EmbeddingModelGuard;
  /**
   * Per-collection DuckDB pool — present when codegraph is wired. CollectionOps
   * uses it to delete the per-collection DuckDB file when the Qdrant collection
   * is dropped; omitted → Qdrant-only cleanup.
   */
  codegraphPool?: GraphDbClientPool;
}

/** The App-layer ops pair `createApp` delegates collection/document endpoints to. */
export interface AppOpsComposition {
  collection: CollectionOps;
  document: DocumentOps;
}

/**
 * Compose the App-layer ops (CollectionOps + DocumentOps) over ONE shared
 * `DocumentMetadataSchemaCompiler` — the schema `create_collection` compiles
 * is the validator `add_documents` then finds cached. Construction lives in
 * the composition root so `public/app.ts` receives ready handlers via DI
 * instead of importing ops modules: bootstrap calls this explicitly, and
 * `createApp` falls back to it for callers that hand raw `AppDeps` handles
 * only (the bare-AppDeps test path).
 */
export function composeAppOps(deps: AppOpsDeps): AppOpsComposition {
  const metadataSchemas = new DocumentMetadataSchemaCompiler();
  return {
    collection: new CollectionOps(
      deps.qdrant,
      deps.embeddings,
      deps.quantizationScalar,
      deps.turboQuant,
      deps.modelGuard,
      deps.codegraphPool,
      metadataSchemas,
    ),
    document: new DocumentOps(deps.qdrant, deps.embeddings, deps.modelGuard, metadataSchemas),
  };
}

/**
 * The architecture report for a collection with no codegraph database:
 * nothing read, `edgeCount: 0` telling it apart from a judged clean graph —
 * `ArchitectureReportOps.empty`, surfaced by the composition root so the
 * App's codegraph-off fallback needs no deep ops import.
 */
export function emptyArchitectureReport(request: GetArchitectureReportRequest): GetArchitectureReportResponse {
  return ArchitectureReportOps.empty(request);
}

/**
 * The ontology report for a collection with no readable codegraph: nothing
 * read, requested sections empty — `OntologyReportOps.empty`, surfaced by
 * the composition root for the same reason as `emptyArchitectureReport`.
 */
export function emptyOntologyReport(request: GetOntologyReportRequest): GetOntologyReportResponse {
  return OntologyReportOps.empty(request);
}

/**
 * The co-change answer for a collection with no codegraph database: `built
 * false`, every requested file listed with no partners — honest empty, never
 * "no partners". `CochangeOps.empty`, surfaced by the composition root for
 * the same reason as `emptyArchitectureReport`.
 */
export function emptyCochangeResult(request: FindCoChangedRequest): FindCoChangedResult {
  return CochangeOps.empty(request.files);
}

/**
 * The review answer for a server with no codegraph wiring: every requested
 * section not built, envelope zeroed — `ReviewChangesOps.empty`, surfaced by
 * the composition root for the same reason as `emptyArchitectureReport`.
 */
export function emptyReviewChangesResult(request: ReviewChangesRequest): ReviewChangesResult {
  return ReviewChangesOps.empty(request);
}
