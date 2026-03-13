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

  domains/                             # Domain modules (orchestration + implementation)
    explore/                           # Query-time exploration engine
      reranker.ts                      # Reranker: scoring, overlay mask, adaptive bounds
      explore-module.ts                # Vector search execution (dense/hybrid)
      rank-module.ts                   # Scroll-based chunk ranking
      post-process.ts                  # computeFetchLimit, postProcess, filterMetaOnly
      rerank/
        presets/
          index.ts                     # resolvePresets() + getPresetNames/Weights

    trajectory/                        # Provider implementations
      static/
        index.ts                       # StaticTrajectory: base signals, structural derived
        provider.ts                    # StaticPayloadBuilder.buildPayload()
        payload-signals.ts             # BASE_PAYLOAD_SIGNALS
        filters.ts                     # staticFilters
        rerank/
          derived-signals/             # Structural signal classes (1 per file)
          presets/                      # RelevancePreset, DecompositionPreset
      git/
        signals.ts                     # gitSignals: Signal[]
        rerank/
          derived-signals/             # Git signal classes (1 per file)
          presets/                      # TechDebt, Hotspots, CodeReview, etc.
        filters.ts                     # gitFilters: FilterDescriptor[]
        provider.ts                    # GitEnrichmentProvider
        infra/                         # readers, metrics, caches

    ingest/                            # Indexing pipeline
      collection-stats.ts              # computeCollectionStats
      pipeline/
        enrichment/                    # coordinator, applier

  infra/                               # Foundation: utilities (lowest layer)
    runtime.ts                         # isDebug(), setDebug()
    collection-name.ts                 # validatePath, resolveCollectionName, resolveCollection
    schema-drift-monitor.ts            # SchemaDriftMonitor: payload version tracking
    stats-cache.ts                     # StatsCache: collection signal stats persistence

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
