---
paths:
  - "src/core/**"
  - "src/bootstrap/**"
  - "src/mcp/**"
---

# Project Structure

```
core/
  api/                                 # Composition root + unified App interface
    index.ts                           # Barrel: re-exports public/ + selected internal
    public/
      app.ts                           # App interface + createApp() + AppDeps
      dto/
        explore.ts                     # Search request/response DTOs
        ingest.ts                      # Indexing DTOs (IndexOptions, IndexStats, etc.)
        collection.ts                  # Collection CRUD DTOs
        document.ts                    # Document add/delete DTOs
        index.ts                       # DTO barrel
      index.ts                         # Public barrel (App + DTOs)
    internal/
      composition.ts                   # createComposition(): trajectory registry assembly
      facades/
        explore-facade.ts              # ExploreFacade: orchestrates explore/ domain
        ingest-facade.ts               # IngestFacade: orchestrates ingest/ domain
      ops/
        collection-ops.ts              # CollectionOps: CRUD on collections
        document-ops.ts                # DocumentOps: add/delete documents
      infra/
        schema-builder.ts              # SchemaBuilder: dynamic MCP schemas via Reranker API (DIP)

  explore/                             # Domain module: query-time exploration engine
    reranker.ts                        # Reranker: scoring, overlay mask, adaptive bounds
    explore-module.ts                  # Vector search execution (dense/hybrid)
    rank-module.ts                     # Scroll-based chunk ranking
    post-process.ts                    # computeFetchLimit, postProcess, filterMetaOnly
    rerank/
      presets/
        index.ts                       # resolvePresets() + getPresetNames/Weights (engine utility)

  infra/                               # Foundation: utilities (lowest layer)
    runtime.ts                         # isDebug(), setDebug()
    collection-name.ts                 # validatePath, resolveCollectionName, resolveCollection
    schema-drift-monitor.ts            # SchemaDriftMonitor: payload version tracking
    stats-cache.ts                     # StatsCache: collection signal stats persistence

  trajectory/                          # Domain module: provider implementations
    static/
      index.ts                         # StaticTrajectory: base signals, structural derived, generic presets
      provider.ts                      # StaticPayloadBuilder.buildPayload(chunk, codebasePath)
      payload-signals.ts               # BASE_PAYLOAD_SIGNALS (base Qdrant payload fields)
      filters.ts                       # staticFilters: language, fileExtension, chunkType, isDocumentation
      rerank/
        derived-signals/               # Structural signal classes (1 per file)
          similarity.ts                # class SimilaritySignal
          chunk-size.ts                # class ChunkSizeSignal
          chunk-density.ts             # class ChunkDensitySignal
          documentation.ts             # class DocumentationSignal
          imports.ts                   # class ImportsSignal
          path-risk.ts                 # class PathRiskSignal
          index.ts                     # staticDerivedSignals: DerivedSignalDescriptor[]
        presets/
          relevance.ts                 # class RelevancePreset (multi-tool)
          decomposition.ts             # class DecompositionPreset (multi-tool)
          index.ts                     # STATIC_PRESETS[]
    git/
      signals.ts                       # gitSignals: Signal[] (raw payload field docs)
      rerank/
        derived-signals/               # Git signal classes (1 per file) + shared helpers
          helpers.ts                   # computeAlpha, blend, payload accessors
          recency.ts                   # class RecencySignal
          stability.ts                 # class StabilitySignal
          churn.ts                     # class ChurnSignal
          age.ts                       # class AgeSignal
          ownership.ts                 # class OwnershipSignal
          bug-fix.ts                   # class BugFixSignal
          volatility.ts                # class VolatilitySignal
          density.ts                   # class DensitySignal
          chunk-churn.ts               # class ChunkChurnSignal
          relative-churn-norm.ts       # class RelativeChurnNormSignal
          burst-activity.ts            # class BurstActivitySignal
          knowledge-silo.ts            # class KnowledgeSiloSignal
          chunk-relative-churn.ts      # class ChunkRelativeChurnSignal
          block-penalty.ts             # class BlockPenaltySignal
          index.ts                     # gitDerivedSignals: DerivedSignalDescriptor[]
        presets/                       # Preset classes (1 per file)
          tech-debt.ts                 # class TechDebtPreset
          hotspots.ts                  # class HotspotsPreset
          code-review.ts               # class CodeReviewPreset
          onboarding.ts                # class OnboardingPreset
          security-audit.ts            # class SecurityAuditPreset
          refactoring.ts               # class RefactoringPreset
          ownership.ts                 # class OwnershipPreset
          recent.ts                    # class RecentPreset
          stable.ts                    # class StablePreset
          index.ts                     # barrel + GIT_PRESETS array
      filters.ts                       # gitFilters: FilterDescriptor[]
      provider.ts                      # GitEnrichmentProvider
      infra/                           # readers, metrics, caches

  ingest/                              # Domain module: indexing pipeline
    collection-stats.ts                # computeCollectionStats
    pipeline/
      enrichment/                      # coordinator, applier

  contracts/                           # Foundation: interfaces + registries
    signal-utils.ts                    # normalize, p95, payload resolvers
    types/
      provider.ts                      # Signal, FilterDescriptor, FilterLevel,
                                       # ScoringWeights, PayloadBuilder,
                                       # EnrichmentProvider, FileSignalTransform,
                                       # FileSignalOverlay, ChunkSignalOverlay
      reranker.ts                      # RerankableResult, RerankPreset,
                                       # OverlayMask, RerankMode,
                                       # DerivedSignalDescriptor,
                                       # RankingOverlay, RerankedResult
      config.ts                        # EmbeddingConfig, TrajectoryGitConfig,
                                       # QdrantTuneConfig (consumed by core/)
    index.ts                           # barrel re-export

  adapters/                            # Foundation: external system types
    qdrant/
      types.ts                         # QdrantFilter, QdrantFilterCondition
      filters/
        utils.ts                       # mergeQdrantFilters (pure filter merge)
      client.ts                        # QdrantManager (REST client wrapper)
      embedded/                        # Embedded Qdrant daemon
        daemon.ts                      # Process manager with refcounting
        download.ts                    # Binary downloader (postinstall + lazy)
        types.ts                       # DaemonPaths, QdrantResolution
    git/
    embeddings/
```
