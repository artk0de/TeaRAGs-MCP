---
title: Changelog
sidebar_position: 99
---

## 1.0.0 (2026-03-13)

- chore(ci): reduce CI output to errors and warnings only
  ([c89e11b](https://github.com/artk0de/TeaRAGs-MCP/commit/c89e11b))
- chore(config): add files field for npm publish
  ([195ca16](https://github.com/artk0de/TeaRAGs-MCP/commit/195ca16))
- chore(config): add md/json/yaml/css to lint-staged prettier
  ([dc307c9](https://github.com/artk0de/TeaRAGs-MCP/commit/dc307c9))
- chore(config): update rule paths from search/ to explore/
  ([1e773cb](https://github.com/artk0de/TeaRAGs-MCP/commit/1e773cb))
- chore(dx): add .claude/\*\*/.local/ to .gitignore
  ([f29de79](https://github.com/artk0de/TeaRAGs-MCP/commit/f29de79))
- chore(dx): add skills for MCP endpoint and DTO creation
  ([0f9b1b1](https://github.com/artk0de/TeaRAGs-MCP/commit/0f9b1b1))
- fix(embedded): set cwd for Qdrant daemon to binary directory
  ([db2e10b](https://github.com/artk0de/TeaRAGs-MCP/commit/db2e10b))
- fix(embedded): store Qdrant binary in ~/.tea-rags/qdrant/bin/
  ([47839e7](https://github.com/artk0de/TeaRAGs-MCP/commit/47839e7))
- fix(embedded): use env vars instead of CLI args for Qdrant config
  ([bf09cd7](https://github.com/artk0de/TeaRAGs-MCP/commit/bf09cd7))
- fix(presets): remove search_code from decomposition preset tools
  ([015f87b](https://github.com/artk0de/TeaRAGs-MCP/commit/015f87b))
- fix(rerank): rank_chunks scoring, overlay visibility, and preset tuning
  ([69f9dff](https://github.com/artk0de/TeaRAGs-MCP/commit/69f9dff))
- fix(test): make validatePath test cross-platform
  ([4807cb7](https://github.com/artk0de/TeaRAGs-MCP/commit/4807cb7))
- style: run prettier on all source and test files
  ([2e99305](https://github.com/artk0de/TeaRAGs-MCP/commit/2e99305))
- refactor: migrate home directory from .tea-rags-mcp to .tea-rags
  ([6235cc6](https://github.com/artk0de/TeaRAGs-MCP/commit/6235cc6))
- refactor: move embedded qdrant to core/adapters/qdrant/embedded
  ([17d7ad5](https://github.com/artk0de/TeaRAGs-MCP/commit/17d7ad5))
- refactor(adapters): extract mergeQdrantFilters, add
  TrajectoryRegistry.buildMergedFilter
  ([4f3cf13](https://github.com/artk0de/TeaRAGs-MCP/commit/4f3cf13))
- refactor(adapters): move filter-utils.ts → filters/utils.ts
  ([3cb2dec](https://github.com/artk0de/TeaRAGs-MCP/commit/3cb2dec))
- refactor(api): move domain modules into core/domains/
  ([ae404ce](https://github.com/artk0de/TeaRAGs-MCP/commit/ae404ce))
- refactor(api): split core/api/ into public/ and internal/
  ([2c419ee](https://github.com/artk0de/TeaRAGs-MCP/commit/2c419ee))
- refactor(bootstrap): add App to AppContext via createApp()
  ([7fe2216](https://github.com/artk0de/TeaRAGs-MCP/commit/7fe2216))
- refactor(config): add ResolvedPaths to AppConfig, DI all path consumers
  ([522481a](https://github.com/artk0de/TeaRAGs-MCP/commit/522481a))
- refactor(contracts): consolidate search types → ExploreResponse,
  ExploreCodeRequest
  ([0c62860](https://github.com/artk0de/TeaRAGs-MCP/commit/0c62860))
- refactor(contracts): extract App DTOs from api/app.ts to
  contracts/types/app.ts
  ([b3fe83d](https://github.com/artk0de/TeaRAGs-MCP/commit/b3fe83d))
- refactor(contracts): move EmbeddingConfig, TrajectoryGitConfig,
  QdrantTuneConfig to core/contracts
  ([e4ce1b7](https://github.com/artk0de/TeaRAGs-MCP/commit/e4ce1b7))
- refactor(dx): split CLAUDE.md/AGENTS.md into focused rules
  ([4399abd](https://github.com/artk0de/TeaRAGs-MCP/commit/4399abd))
- refactor(explore): add BaseExploreStrategy with shared defaults, postProcess,
  metaOnly ([8282790](https://github.com/artk0de/TeaRAGs-MCP/commit/8282790))
- refactor(explore): add rerank and metaOnly to SearchContext
  ([58d8724](https://github.com/artk0de/TeaRAGs-MCP/commit/58d8724))
- refactor(explore): collapse searchCodeTyped+searchCode into single
  searchCode(DTO)
  ([5bb6b1a](https://github.com/artk0de/TeaRAGs-MCP/commit/5bb6b1a))
- refactor(explore): delete ExploreModule, legacy types, consolidate
  ExploreResponse
  ([e99295d](https://github.com/artk0de/TeaRAGs-MCP/commit/e99295d))
- refactor(explore): ExploreFacade deps object, delegate buildMergedFilter to
  registry ([dee9179](https://github.com/artk0de/TeaRAGs-MCP/commit/dee9179))
- refactor(explore): HybridSearchStrategy extends BaseExploreStrategy
  ([da56f75](https://github.com/artk0de/TeaRAGs-MCP/commit/da56f75))
- refactor(explore): remove excludeDocumentation from ScrollRankStrategy
  ([13f4286](https://github.com/artk0de/TeaRAGs-MCP/commit/13f4286))
- refactor(explore): rename RawResult → ExploreResult<P>, executeSearch →
  executeExplore
  ([0cfdc8e](https://github.com/artk0de/TeaRAGs-MCP/commit/0cfdc8e))
- refactor(explore): rename search domain to explore
  ([e7ec383](https://github.com/artk0de/TeaRAGs-MCP/commit/e7ec383))
- refactor(explore): rename search module to explore
  ([1cde3de](https://github.com/artk0de/TeaRAGs-MCP/commit/1cde3de))
- refactor(explore): rename SearchContext → ExploreContext
  ([4d9f572](https://github.com/artk0de/TeaRAGs-MCP/commit/4d9f572))
- refactor(explore): rename SearchStrategy → ExploreStrategy, extract base class
  to base.ts ([88f4fe8](https://github.com/artk0de/TeaRAGs-MCP/commit/88f4fe8))
- refactor(explore): rewrite ExploreFacade with unified strategy pipeline
  ([9c2d242](https://github.com/artk0de/TeaRAGs-MCP/commit/9c2d242))
- refactor(explore): ScrollRankStrategy extends BaseExploreStrategy with own
  defaults ([4727a38](https://github.com/artk0de/TeaRAGs-MCP/commit/4727a38))
- refactor(explore): update strategy factory and barrel, createSearchStrategy →
  createExploreStrategy
  ([6b9d81d](https://github.com/artk0de/TeaRAGs-MCP/commit/6b9d81d))
- refactor(explore): VectorSearchStrategy extends BaseExploreStrategy
  ([b2d8154](https://github.com/artk0de/TeaRAGs-MCP/commit/b2d8154))
- refactor(filters): extend FilterDescriptor for must_not support
  (FilterConditionResult)
  ([3be7a04](https://github.com/artk0de/TeaRAGs-MCP/commit/3be7a04))
- refactor(infra): extract isDebug into core/infra layer
  ([d939542](https://github.com/artk0de/TeaRAGs-MCP/commit/d939542))
- refactor(infra): move collection utils from ingest/ to
  infra/collection-name.ts
  ([4c64b8d](https://github.com/artk0de/TeaRAGs-MCP/commit/4c64b8d))
- refactor(infra): move StatsCache and SchemaDriftMonitor from api/ to infra/
  ([76ef5b1](https://github.com/artk0de/TeaRAGs-MCP/commit/76ef5b1))
- refactor(ingest): move collection utilities from contracts to ingest
  ([eee9259](https://github.com/artk0de/TeaRAGs-MCP/commit/eee9259))
- refactor(mcp): thin MCP handlers delegating to unified App interface
  ([bfe5f55](https://github.com/artk0de/TeaRAGs-MCP/commit/bfe5f55))
- refactor(search): remove trajectory dependency via DI filter builder
  ([c80c6ee](https://github.com/artk0de/TeaRAGs-MCP/commit/c80c6ee))
- docs: add scope-based versioning rules and improve commit type
  ([82137d9](https://github.com/artk0de/TeaRAGs-MCP/commit/82137d9))
- docs(api): add GRASP/SOLID cleanup design spec
  ([1baad7a](https://github.com/artk0de/TeaRAGs-MCP/commit/1baad7a))
- docs(api): add GRASP/SOLID cleanup implementation plan
  ([5abbe3f](https://github.com/artk0de/TeaRAGs-MCP/commit/5abbe3f))
- docs(config): update CLAUDE.md for domain boundaries and explore rename
  ([3f498da](https://github.com/artk0de/TeaRAGs-MCP/commit/3f498da))
- docs(explore): add unified explore filters & type consolidation design spec
  ([b2d83d0](https://github.com/artk0de/TeaRAGs-MCP/commit/b2d83d0))
- docs(infra): update CLAUDE.md layer descriptions and project structure
  ([cb990d6](https://github.com/artk0de/TeaRAGs-MCP/commit/cb990d6))
- docs(website): update documentation for embedded Qdrant and package rename
  ([56dc94d](https://github.com/artk0de/TeaRAGs-MCP/commit/56dc94d))
- feat(api): add App interface and typed response types
  ([7045b9a](https://github.com/artk0de/TeaRAGs-MCP/commit/7045b9a))
- feat(api): add CollectionOps and DocumentOps
  ([21a67d2](https://github.com/artk0de/TeaRAGs-MCP/commit/21a67d2))
- feat(api): add createApp() factory, rename SearchFacade → ExploreFacade
  ([8ce014c](https://github.com/artk0de/TeaRAGs-MCP/commit/8ce014c))
- feat(api): expand SearchFacade with semantic/hybrid/rank methods
  ([4c2c3dc](https://github.com/artk0de/TeaRAGs-MCP/commit/4c2c3dc))
- feat(embedded): add Qdrant binary downloader and postinstall script
  ([df7494d](https://github.com/artk0de/TeaRAGs-MCP/commit/df7494d))
- feat(embedded): add Qdrant daemon with refcounting and idle shutdown
  ([82734d7](https://github.com/artk0de/TeaRAGs-MCP/commit/82734d7))
- feat(embedded): add version lock, Qdrant docs page, and strict lint
  ([914a4f0](https://github.com/artk0de/TeaRAGs-MCP/commit/914a4f0))
- feat(embedded): add Windows support for Qdrant binary download
  ([f35d49f](https://github.com/artk0de/TeaRAGs-MCP/commit/f35d49f))
- feat(embedded): integrate Qdrant daemon into bootstrap
  ([ca5f14b](https://github.com/artk0de/TeaRAGs-MCP/commit/ca5f14b))
- feat(explore): add buildMergedFilter + TypedFilterParams for typed search
  filters ([e6e0a7a](https://github.com/artk0de/TeaRAGs-MCP/commit/e6e0a7a))
- feat(explore): add exploreCode method with auto-detect hybrid and typed
  filters ([5098920](https://github.com/artk0de/TeaRAGs-MCP/commit/5098920))
- feat(explore): add search strategies + post-process module
  ([6b7d827](https://github.com/artk0de/TeaRAGs-MCP/commit/6b7d827))
- feat(mcp): add rank_chunks tool with scroll-based chunk ranking
  ([f09c0a0](https://github.com/artk0de/TeaRAGs-MCP/commit/f09c0a0))
- feat(mcp): add typed filter params to all search tool schemas
  ([d335a6c](https://github.com/artk0de/TeaRAGs-MCP/commit/d335a6c))
- feat(mcp): pass typed filter params through all search handlers
  ([aa841c6](https://github.com/artk0de/TeaRAGs-MCP/commit/aa841c6))
- feat(presets): add rank_chunks to all preset tool lists
  ([c75b7a7](https://github.com/artk0de/TeaRAGs-MCP/commit/c75b7a7))
- feat(search): add RankModule for scroll-based chunk ranking
  ([10ba9b0](https://github.com/artk0de/TeaRAGs-MCP/commit/10ba9b0))
- improve(api): address App interface review feedback
  ([bb1bd26](https://github.com/artk0de/TeaRAGs-MCP/commit/bb1bd26))
- improve(explore): add barrel export and fix type casts in strategies
  ([ac2e923](https://github.com/artk0de/TeaRAGs-MCP/commit/ac2e923))
- improve(presets): refine rank_chunks and add hybrid_search to preset tool
  lists ([badd8d1](https://github.com/artk0de/TeaRAGs-MCP/commit/badd8d1))
- feat!: rename package to tea-rags
  ([3e8a79f](https://github.com/artk0de/TeaRAGs-MCP/commit/3e8a79f))
- ci: configure BREAKING CHANGE ordering and commit rules
  ([a4e4e87](https://github.com/artk0de/TeaRAGs-MCP/commit/a4e4e87))
- ci: use dot reporter for vitest to show only failures
  ([a7c380c](https://github.com/artk0de/TeaRAGs-MCP/commit/a7c380c))

### BREAKING CHANGE

- package renamed from @artk0de/tea-rags-mcp to tea-rags. Binary command renamed
  from qdrant-mcp-server to tea-rags.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>

- QDRANT_URL default changed from http://localhost:6333 to autodetect. Set
  QDRANT_URL explicitly if using external Qdrant.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>

## 0.9.0 (2026-03-08)

- fix: resolve all ESLint errors and warnings (73 → 0)
  ([bd7e337](https://github.com/artk0de/TeaRAGs-MCP/commit/bd7e337))
- fix(onnx): resolve eslint warnings in daemon and worker
  ([7e7633a](https://github.com/artk0de/TeaRAGs-MCP/commit/7e7633a))
- fix(onnx): revert pipeline batch size propagation, fix probe diversity
  ([36384fc](https://github.com/artk0de/TeaRAGs-MCP/commit/36384fc))
- fix(test): stabilize flaky git-log-reader date filter test
  ([a8e7099](https://github.com/artk0de/TeaRAGs-MCP/commit/a8e7099))
- docs: add design docs for daemon batching and adaptive batch size
  ([8d7510e](https://github.com/artk0de/TeaRAGs-MCP/commit/8d7510e))
- docs: update ONNX provider scale and batch size documentation
  ([49319c4](https://github.com/artk0de/TeaRAGs-MCP/commit/49319c4))
- refactor(onnx): move recommendedPipelineBatchSize to BatchSizeController
  ([5317982](https://github.com/artk0de/TeaRAGs-MCP/commit/5317982))
- refactor(onnx): rename GPU_BATCH_SIZE to DEFAULT_GPU_BATCH_SIZE, add adaptive
  constants ([e5c641d](https://github.com/artk0de/TeaRAGs-MCP/commit/e5c641d))
- feat(onnx): add BatchSizeController for adaptive GPU batch sizing
  ([5e4f541](https://github.com/artk0de/TeaRAGs-MCP/commit/5e4f541))
- feat(onnx): add calibrationCachePath to paths module
  ([b2969dd](https://github.com/artk0de/TeaRAGs-MCP/commit/b2969dd))
- feat(onnx): add daemon-side batch splitting for GPU-safe inference
  ([3000740](https://github.com/artk0de/TeaRAGs-MCP/commit/3000740))
- feat(onnx): add GPU_BATCH_SIZE constant
  ([d65b160](https://github.com/artk0de/TeaRAGs-MCP/commit/d65b160))
- feat(onnx): add worker timing, calibration probe, and cache
  ([4912a6f](https://github.com/artk0de/TeaRAGs-MCP/commit/4912a6f))
- feat(onnx): expose recommendedBatchSize from OnnxEmbeddings
  ([23f5d56](https://github.com/artk0de/TeaRAGs-MCP/commit/23f5d56))
- feat(onnx): integrate BatchSizeController into daemon
  ([ed5bc7b](https://github.com/artk0de/TeaRAGs-MCP/commit/ed5bc7b))
- feat(onnx): pipeline uses GPU-calibrated batch size when not explicitly
  configured ([ec19920](https://github.com/artk0de/TeaRAGs-MCP/commit/ec19920))
- feat(onnx): recommendedBatchSize = max(32, calibrated \* 2)
  ([23bde57](https://github.com/artk0de/TeaRAGs-MCP/commit/23bde57))
- feat(onnx): restore pipeline batch size propagation from calibration
  ([5636959](https://github.com/artk0de/TeaRAGs-MCP/commit/5636959))
- perf(onnx): add session options and warm-up batch for GPU inference
  ([8e4d50f](https://github.com/artk0de/TeaRAGs-MCP/commit/8e4d50f))
- perf(onnx): raise default pipeline batch size from 8 to 32
  ([a0ec051](https://github.com/artk0de/TeaRAGs-MCP/commit/a0ec051))
- chore: add .dolt/ and \*.db to root .gitignore
  ([d110cfb](https://github.com/artk0de/TeaRAGs-MCP/commit/d110cfb))
- chore: remove unused check-coverage hook
  ([19c0d8f](https://github.com/artk0de/TeaRAGs-MCP/commit/19c0d8f))
- chore(beads): untrack SQLite db files covered by .gitignore
  ([f0f4be4](https://github.com/artk0de/TeaRAGs-MCP/commit/f0f4be4))

## 0.8.0 (2026-03-07)

- chore: add remark-frontmatter dependency
  ([c472322](https://github.com/artk0de/TeaRAGs-MCP/commit/c472322))
- chore: AGENTS.md beads upgrade
  ([7bb835e](https://github.com/artk0de/TeaRAGs-MCP/commit/7bb835e))
- chore: enforce coverage threshold in pre-commit hook
  ([48338b7](https://github.com/artk0de/TeaRAGs-MCP/commit/48338b7))
- chore(beads): close 2o2 (squash-aware sessions), open 6h3 (trace_metrics)
  ([4846ccd](https://github.com/artk0de/TeaRAGs-MCP/commit/4846ccd))
- chore(beads): sync issues, add post-merge hook, close 47m
  ([af4a5b7](https://github.com/artk0de/TeaRAGs-MCP/commit/af4a5b7))
- chore(deps): add @huggingface/transformers as optional dependency
  ([c156b5d](https://github.com/artk0de/TeaRAGs-MCP/commit/c156b5d))
- chore(scripts): update verify-providers to use makeConfig helper
  ([9b0ff9f](https://github.com/artk0de/TeaRAGs-MCP/commit/9b0ff9f))
- docs: add markdown chunker implementation plan
  ([e01ffb8](https://github.com/artk0de/TeaRAGs-MCP/commit/e01ffb8))
- docs: add markdown chunker quality improvement design
  ([91f2c86](https://github.com/artk0de/TeaRAGs-MCP/commit/91f2c86))
- docs: add ONNX worker thread design
  ([242693f](https://github.com/artk0de/TeaRAGs-MCP/commit/242693f))
- docs(providers): add embedding provider pages and refactor config
  ([315c6d1](https://github.com/artk0de/TeaRAGs-MCP/commit/315c6d1))
- test: raise code coverage to 97% with 48 new tests across 18 files
  ([fb7e369](https://github.com/artk0de/TeaRAGs-MCP/commit/fb7e369))
- test(chunker): add oversized section test (spec review fix)
  ([5d3f5cd](https://github.com/artk0de/TeaRAGs-MCP/commit/5d3f5cd))
- test(decomposition): add integration tests for methodLines/methodDensity
  scoring ([6f48709](https://github.com/artk0de/TeaRAGs-MCP/commit/6f48709))
- test(onnx): add daemon end-to-end integration test
  ([543ac56](https://github.com/artk0de/TeaRAGs-MCP/commit/543ac56))
- test(onnx): raise daemon coverage to 97%
  ([19c3d39](https://github.com/artk0de/TeaRAGs-MCP/commit/19c3d39))
- test(trajectory/static): add tests for StaticTrajectory, PayloadBuilder,
  filters + update CLAUDE.md
  ([79097c1](https://github.com/artk0de/TeaRAGs-MCP/commit/79097c1))
- feat(chunker): add MarkdownChunker with frontmatter, code block dedup, and
  Mermaid filtering
  ([daa7b13](https://github.com/artk0de/TeaRAGs-MCP/commit/daa7b13))
- feat(chunker): populate methodLines in tree-sitter, add methodDensity to
  payload ([fbfb0fa](https://github.com/artk0de/TeaRAGs-MCP/commit/fbfb0fa))
- feat(config): add "onnx" to embedding provider enum
  ([0349b96](https://github.com/artk0de/TeaRAGs-MCP/commit/0349b96))
- feat(config): add daemon socket and PID file paths
  ([f789d17](https://github.com/artk0de/TeaRAGs-MCP/commit/f789d17))
- feat(config): add ingest, trajectoryGit, qdrantTune zod slices
  ([ed85601](https://github.com/artk0de/TeaRAGs-MCP/commit/ed85601))
- feat(config): standardize env var naming with category prefixes
  ([4b8acf2](https://github.com/artk0de/TeaRAGs-MCP/commit/4b8acf2))
- feat(config): zod schema for core + embedding slices
  ([2b132d0](https://github.com/artk0de/TeaRAGs-MCP/commit/2b132d0))
- feat(drift): payload schema drift detection — warn agent once per session
  ([25e0013](https://github.com/artk0de/TeaRAGs-MCP/commit/25e0013))
- feat(embedding): adaptive batch sizing with exponential backoff
  ([3d90152](https://github.com/artk0de/TeaRAGs-MCP/commit/3d90152))
- feat(embedding): add OnnxEmbeddings provider with lazy loading
  ([ae1ea68](https://github.com/artk0de/TeaRAGs-MCP/commit/ae1ea68))
- feat(embedding): cache models in ~/.tea-rags-mcp, guided HF auth, int8 default
  ([8474e6a](https://github.com/artk0de/TeaRAGs-MCP/commit/8474e6a))
- feat(embedding): safe initial batch size, DI for cacheDir, backoff tests
  ([5df5876](https://github.com/artk0de/TeaRAGs-MCP/commit/5df5876))
- feat(embedding): wire OnnxEmbeddings into factory
  ([c5eba6a](https://github.com/artk0de/TeaRAGs-MCP/commit/c5eba6a))
- feat(factory): wire daemon socket paths into OnnxEmbeddings
  ([229e5f8](https://github.com/artk0de/TeaRAGs-MCP/commit/229e5f8))
- feat(hybrid): replace RRF/DBSF with weighted score fusion
  ([0539075](https://github.com/artk0de/TeaRAGs-MCP/commit/0539075))
- feat(onnx): add daemon CLI entry point and spawn logic
  ([a0ccdf8](https://github.com/artk0de/TeaRAGs-MCP/commit/a0ccdf8))
- feat(onnx): add daemon protocol types and NDJSON serialization
  ([637875b](https://github.com/artk0de/TeaRAGs-MCP/commit/637875b))
- feat(onnx): add EMBEDDING_DEVICE config with auto-detect and GPU fallback
  ([864af4e](https://github.com/artk0de/TeaRAGs-MCP/commit/864af4e))
- feat(onnx): add NDJSON line splitter for socket communication
  ([7244276](https://github.com/artk0de/TeaRAGs-MCP/commit/7244276))
- feat(onnx): add process exit hook and GPU sequential lock
  ([1662322](https://github.com/artk0de/TeaRAGs-MCP/commit/1662322))
- feat(onnx): add worker thread message types
  ([da9f08d](https://github.com/artk0de/TeaRAGs-MCP/commit/da9f08d))
- feat(onnx): implement daemon server with Unix socket and lifecycle management
  ([e93ea97](https://github.com/artk0de/TeaRAGs-MCP/commit/e93ea97))
- feat(onnx): move inference to worker thread, rewrite proxy
  ([0ce8d35](https://github.com/artk0de/TeaRAGs-MCP/commit/0ce8d35))
- feat(onnx): rewrite OnnxEmbeddings as daemon socket client
  ([575f617](https://github.com/artk0de/TeaRAGs-MCP/commit/575f617))
- feat(onnx): switch to WebGPU + FP16 for 2.5x faster embeddings
  ([ca4f7ab](https://github.com/artk0de/TeaRAGs-MCP/commit/ca4f7ab))
- feat(rerank): add decomposition preset with chunkDensity signal
  ([f93605f](https://github.com/artk0de/TeaRAGs-MCP/commit/f93605f))
- feat(search): raise candidate pool defaults to ×4/×6 with min 20
  ([0760beb](https://github.com/artk0de/TeaRAGs-MCP/commit/0760beb))
- feat(signals): ChunkSizeSignal reads methodLines, fix readRawSource for
  top-level keys
  ([5c5ce21](https://github.com/artk0de/TeaRAGs-MCP/commit/5c5ce21))
- feat(trajectory): add squash-aware session grouping for git metrics
  ([99c1633](https://github.com/artk0de/TeaRAGs-MCP/commit/99c1633))
- feat(trajectory): create static trajectory module with signals, presets,
  filters, payload builder
  ([ce024fe](https://github.com/artk0de/TeaRAGs-MCP/commit/ce024fe))
- feat(types): add methodLines to CodeChunk metadata
  ([b7097d2](https://github.com/artk0de/TeaRAGs-MCP/commit/b7097d2))
- fix: methodLins now correctly writes in chunk payload
  ([23a4fe3](https://github.com/artk0de/TeaRAGs-MCP/commit/23a4fe3))
- fix: methodLins now correctly writes in chunk payload
  ([c60d73b](https://github.com/artk0de/TeaRAGs-MCP/commit/c60d73b))
- fix: update stale comment ref to MarkdownChunker
  ([6fef9a9](https://github.com/artk0de/TeaRAGs-MCP/commit/6fef9a9))
- fix(chunker): graceful worker shutdown to eliminate flaky test crashes
  ([cc918bd](https://github.com/artk0de/TeaRAGs-MCP/commit/cc918bd))
- fix(chunker): splitOversizedChunk gives sub-chunks correct startLine/endLine
  ([5085d7a](https://github.com/artk0de/TeaRAGs-MCP/commit/5085d7a))
- fix(chunker): strip frontmatter from whole-document fallback
  ([252454c](https://github.com/artk0de/TeaRAGs-MCP/commit/252454c))
- fix(config): send deprecation warnings via MCP logging
  ([9bf2567](https://github.com/artk0de/TeaRAGs-MCP/commit/9bf2567))
- fix(embedding): add ambient types for optional @huggingface/transformers
  ([bf719c3](https://github.com/artk0de/TeaRAGs-MCP/commit/bf719c3))
- fix(embedding): add internal batch splitting to prevent OOM in ONNX
  ([e31ac15](https://github.com/artk0de/TeaRAGs-MCP/commit/e31ac15))
- fix(embedding): fix onnx build errors — proper Dtype typing, remove stale
  ts-expect-error
  ([f295f9d](https://github.com/artk0de/TeaRAGs-MCP/commit/f295f9d))
- fix(embedding): use q8 dtype (maps to model_quantized.onnx), not int8
  ([ef6ed00](https://github.com/artk0de/TeaRAGs-MCP/commit/ef6ed00))
- fix(git): use native child_process timeout instead of JS-level setTimeout
  ([94ac050](https://github.com/artk0de/TeaRAGs-MCP/commit/94ac050))
- fix(logs): use local timezone for pipeline debug log timestamps
  ([2f6ae55](https://github.com/artk0de/TeaRAGs-MCP/commit/2f6ae55))
- fix(mcp): coerce string params to number/boolean, lazy-init debug logger
  ([3249e3b](https://github.com/artk0de/TeaRAGs-MCP/commit/3249e3b))
- fix(signals): ChunkDensitySignal reads methodDensity with adaptive bounds
  ([49a0665](https://github.com/artk0de/TeaRAGs-MCP/commit/49a0665))
- refactor(chunker): wire MarkdownChunker into TreeSitterChunker
  ([933f03f](https://github.com/artk0de/TeaRAGs-MCP/commit/933f03f))
- refactor(composition): register StaticTrajectory, simplify resolvePresets to
  2-level ([6f31b57](https://github.com/artk0de/TeaRAGs-MCP/commit/6f31b57))
- refactor(config): centralize app data paths into config/paths.ts
  ([9fd2721](https://github.com/artk0de/TeaRAGs-MCP/commit/9fd2721))
- refactor(config): kill CodeConfig, use typed Zod slices
  ([64e153e](https://github.com/artk0de/TeaRAGs-MCP/commit/64e153e))
- refactor(config): modularize config.ts into config/ directory
  ([63af188](https://github.com/artk0de/TeaRAGs-MCP/commit/63af188))
- refactor(config): move defaults to config/, fix flaky pre-commit
  ([028e21a](https://github.com/artk0de/TeaRAGs-MCP/commit/028e21a))
- refactor(config): parseAppConfig delegates to Zod, remove validateConfig
  ([ea2c220](https://github.com/artk0de/TeaRAGs-MCP/commit/ea2c220))
- refactor(config): replace debug-logger ENV reads with getConfigDump
  ([8a22861](https://github.com/artk0de/TeaRAGs-MCP/commit/8a22861))
- refactor(debug): centralize DEBUG flag via runtime.ts
  ([1a4dffd](https://github.com/artk0de/TeaRAGs-MCP/commit/1a4dffd))
- refactor(embedding): extract DEFAULT_ONNX_MODEL constant, use jinaai namespace
  ([e457e62](https://github.com/artk0de/TeaRAGs-MCP/commit/e457e62))
- refactor(embedding): extract dtype from model name suffix
  ([86cf8fb](https://github.com/artk0de/TeaRAGs-MCP/commit/86cf8fb))
- refactor(embeddings): DI config slice, remove createFromEnv and process.env
  ([5a86dc1](https://github.com/artk0de/TeaRAGs-MCP/commit/5a86dc1))
- refactor(ingest): DI config slices for pipeline, remove process.env
  ([847d4bc](https://github.com/artk0de/TeaRAGs-MCP/commit/847d4bc))
- refactor(pipeline): delegate payload construction via PayloadBuilder DIP
  ([4d84cd6](https://github.com/artk0de/TeaRAGs-MCP/commit/4d84cd6))
- refactor(qdrant): align hybridSearch contract with search()
  ([89f6e87](https://github.com/artk0de/TeaRAGs-MCP/commit/89f6e87))
- refactor(qdrant): DI config slice for accumulator + client
  ([f31d3e5](https://github.com/artk0de/TeaRAGs-MCP/commit/f31d3e5))
- refactor(trajectory): delete old signal/preset files from search/, contracts/
  ([79cea84](https://github.com/artk0de/TeaRAGs-MCP/commit/79cea84))
- refactor(trajectory): DI config slice, remove process.env
  ([a41bf01](https://github.com/artk0de/TeaRAGs-MCP/commit/a41bf01))
- refactor(trajectory): make enrichment optional on Trajectory interface
  ([97b9d1b](https://github.com/artk0de/TeaRAGs-MCP/commit/97b9d1b))
- refactor(trajectory): rename GIT*\* env vars to TRAJECTORY_GIT*\* prefix
  ([ebd8cc8](https://github.com/artk0de/TeaRAGs-MCP/commit/ebd8cc8))
- ([bb0e815](https://github.com/artk0de/TeaRAGs-MCP/commit/bb0e815))
- ci(release): exclude merge commits from changelog
  ([22e71e4](https://github.com/artk0de/TeaRAGs-MCP/commit/22e71e4))

## 0.7.0 (2026-03-04)

- Merge branch 'main' of github.com:artk0de/TeaRAGs-MCP
  ([63a2531](https://github.com/artk0de/TeaRAGs-MCP/commit/63a2531))
- feat(presets): enrich onboarding with age, ownership penalty, volatility
  ([bb40e25](https://github.com/artk0de/TeaRAGs-MCP/commit/bb40e25))
- feat(presets): enrich stable and recent with multi-signal weights
  ([66f00e7](https://github.com/artk0de/TeaRAGs-MCP/commit/66f00e7))
- ci(release): verify npm token before semantic-release
  ([ec07642](https://github.com/artk0de/TeaRAGs-MCP/commit/ec07642))

## 0.6.0 (2026-03-04)

- feat: wire signal stats lifecycle — cold start + post-index refresh
  ([3d9160d](https://github.com/artk0de/TeaRAGs-MCP/commit/3d9160d))
- feat(adapters): scrollAllPoints helper for collection-wide stats
  ([3169cab](https://github.com/artk0de/TeaRAGs-MCP/commit/3169cab))
- feat(api): add composition root, wire TrajectoryRegistry
  ([d47ffe8](https://github.com/artk0de/TeaRAGs-MCP/commit/d47ffe8))
- feat(api): StatsCache — JSON file persistence for collection signal stats
  ([42ceeee](https://github.com/artk0de/TeaRAGs-MCP/commit/42ceeee))
- feat(chunker): add TypeScript class body chunker hook (AST-based)
  ([af45bc3](https://github.com/artk0de/TeaRAGs-MCP/commit/af45bc3))
- feat(chunker): add TypeScript comment capture hook (AST-based)
  ([1a0de42](https://github.com/artk0de/TeaRAGs-MCP/commit/1a0de42))
- feat(chunker): merge adjacent small top-level declarations into blocks
  ([1661f23](https://github.com/artk0de/TeaRAGs-MCP/commit/1661f23))
- feat(chunker): split markdown only on h1/h2 boundaries
  ([84669d3](https://github.com/artk0de/TeaRAGs-MCP/commit/84669d3))
- feat(chunker): wire TypeScript hooks and enable class method extraction
  ([f0dc534](https://github.com/artk0de/TeaRAGs-MCP/commit/f0dc534))
- feat(contracts): add BASE_PAYLOAD_SIGNALS for static payload fields
  ([7f5dc30](https://github.com/artk0de/TeaRAGs-MCP/commit/7f5dc30))
- feat(contracts): add derivedSignals to EnrichmentProvider, wire in git
  provider ([c076732](https://github.com/artk0de/TeaRAGs-MCP/commit/c076732))
- feat(contracts): add essential flag to PayloadSignalDescriptor
  ([60378ae](https://github.com/artk0de/TeaRAGs-MCP/commit/60378ae))
- feat(contracts): add generic computeCollectionStats() for adaptive thresholds
  ([5bfc6c6](https://github.com/artk0de/TeaRAGs-MCP/commit/5bfc6c6))
- feat(contracts): add PayloadSignalDescriptor, ExtractContext, SignalStats
  types ([0577a47](https://github.com/artk0de/TeaRAGs-MCP/commit/0577a47))
- feat(contracts): create contracts layer with provider and reranker types
  ([34b7c64](https://github.com/artk0de/TeaRAGs-MCP/commit/34b7c64))
- feat(contracts): DerivedSignalDescriptor type, add sources to git signal
  descriptors ([6cbbe3a](https://github.com/artk0de/TeaRAGs-MCP/commit/6cbbe3a))
- feat(contracts): TrajectoryRegistry.getAllDerivedSignals() with duplicate
  validation ([136702f](https://github.com/artk0de/TeaRAGs-MCP/commit/136702f))
- feat(git): add chunk-level taskIds from commit messages
  ([c55ebb8](https://github.com/artk0de/TeaRAGs-MCP/commit/c55ebb8))
- feat(mcp): auto-generate ScoringWeightsSchema from signal descriptors
  ([a2834b7](https://github.com/artk0de/TeaRAGs-MCP/commit/a2834b7))
- feat(reranker): L3 alpha-blending, chunk temporal signals, techDebt redesign
  ([1714371](https://github.com/artk0de/TeaRAGs-MCP/commit/1714371))
- feat(search): add RelevancePreset + preset resolution infrastructure
  ([c079277](https://github.com/artk0de/TeaRAGs-MCP/commit/c079277))
- feat(search): descriptor-based scoring replaces monolith calculateSignals()
  ([14fb640](https://github.com/artk0de/TeaRAGs-MCP/commit/14fb640))
- feat(search): mask git payload in metaOnly by overlay or essential fields
  ([070f556](https://github.com/artk0de/TeaRAGs-MCP/commit/070f556))
- feat(search): Reranker v2 class with ranking overlay, descriptor-based
  metadata ([145412b](https://github.com/artk0de/TeaRAGs-MCP/commit/145412b))
- feat(search): use collection-level p95 as adaptive bounds fallback
  ([1785a76](https://github.com/artk0de/TeaRAGs-MCP/commit/1785a76))
- feat(search): wire essentialTrajectoryFields through deps chain
  ([52f13e8](https://github.com/artk0de/TeaRAGs-MCP/commit/52f13e8))
- feat(search): wire Reranker v2 into search-pipeline and search-module
  ([798e434](https://github.com/artk0de/TeaRAGs-MCP/commit/798e434))
- feat(trajectory): add chunk-level churnVolatility, flat payload descriptors,
  fix volatility blending
  ([2d4d678](https://github.com/artk0de/TeaRAGs-MCP/commit/2d4d678))
- feat(trajectory): add Git trajectory presets with descriptions
  ([026a365](https://github.com/artk0de/TeaRAGs-MCP/commit/026a365))
- feat(trajectory): add scorer classes, metrics decomposition, and config fixes
  ([bc36120](https://github.com/artk0de/TeaRAGs-MCP/commit/bc36120))
- feat(trajectory): add shared trajectory contract types
  ([8d62ac0](https://github.com/artk0de/TeaRAGs-MCP/commit/8d62ac0))
- feat(trajectory): add Trajectory interface and GitTrajectory entry point
  ([422c928](https://github.com/artk0de/TeaRAGs-MCP/commit/422c928))
- feat(trajectory): git signal descriptors and filter descriptors
  ([01f93c2](https://github.com/artk0de/TeaRAGs-MCP/commit/01f93c2))
- feat(trajectory/git): mark ageDays and commitCount as essential signals
  ([5699902](https://github.com/artk0de/TeaRAGs-MCP/commit/5699902))
- feat(website): update docusaurus config and navbar logo
  ([67f8d97](https://github.com/artk0de/TeaRAGs-MCP/commit/67f8d97))
- refactor: consolidate normalize() and p95() in contracts/signal-utils
  ([be0b39d](https://github.com/artk0de/TeaRAGs-MCP/commit/be0b39d))
- refactor: delete duplicate ingest/enrichment/trajectory/git/
  ([35ac52b](https://github.com/artk0de/TeaRAGs-MCP/commit/35ac52b))
- refactor: delete Signal interface, remove dead code
  ([c434720](https://github.com/artk0de/TeaRAGs-MCP/commit/c434720))
- refactor: domain boundaries — Qdrant types, FieldDoc→Signal, CLAUDE.md
  ([772add7](https://github.com/artk0de/TeaRAGs-MCP/commit/772add7))
- refactor: enforce domain boundaries — registry, collection utils, SRP
  ([1a26f65](https://github.com/artk0de/TeaRAGs-MCP/commit/1a26f65))
- refactor: EnrichmentRegistry to contracts/, delete trajectory/types.ts
  ([eda53e2](https://github.com/artk0de/TeaRAGs-MCP/commit/eda53e2))
- refactor: finalize rerank/ directory structure, update CLAUDE.md
  ([9538e01](https://github.com/artk0de/TeaRAGs-MCP/commit/9538e01))
- refactor: merge EnrichmentProvider+QueryContract, propagate overlay types
  ([ed97b04](https://github.com/artk0de/TeaRAGs-MCP/commit/ed97b04))
- refactor: move git payload accessors from contracts/ to trajectory/git/infra/
  ([8927220](https://github.com/artk0de/TeaRAGs-MCP/commit/8927220))
- refactor: move presets into rerank/ directories
  ([3c1a32c](https://github.com/artk0de/TeaRAGs-MCP/commit/3c1a32c))
- refactor: move signal-utils to contracts layer
  ([b3851c6](https://github.com/artk0de/TeaRAGs-MCP/commit/b3851c6))
- refactor: remove scorer classes — wrong abstraction level
  ([d03f6f9](https://github.com/artk0de/TeaRAGs-MCP/commit/d03f6f9))
- refactor: reorganize signals — derived-signals layer, rename payload-fields to
  signals ([68fe7ee](https://github.com/artk0de/TeaRAGs-MCP/commit/68fe7ee))
- refactor: terminology alignment — Metadata→Signals, fix boundary violations
  ([3786fca](https://github.com/artk0de/TeaRAGs-MCP/commit/3786fca))
- refactor: wire Reranker via composition root, make required in all consumers
  ([7c626f4](https://github.com/artk0de/TeaRAGs-MCP/commit/7c626f4))
- refactor(api): add SchemaBuilder — MCP schemas via DIP, no hardcoded imports
  ([50fae12](https://github.com/artk0de/TeaRAGs-MCP/commit/50fae12))
- refactor(chunker): extract shared findClassBody util and clarify offset
  comments ([f38fb57](https://github.com/artk0de/TeaRAGs-MCP/commit/f38fb57))
- refactor(contracts): add OverlayMask type and transition fields to
  RerankPreset
  ([9345c03](https://github.com/artk0de/TeaRAGs-MCP/commit/9345c03))
- refactor(contracts): add RerankPreset interface, update provider preset
  contract ([3b1d476](https://github.com/artk0de/TeaRAGs-MCP/commit/3b1d476))
- refactor(contracts): extensible PayloadSignalDescriptor.stats and SignalStats
  ([b4174bc](https://github.com/artk0de/TeaRAGs-MCP/commit/b4174bc))
- refactor(contracts): extract generic signal math from git helpers
  ([4e4cdbf](https://github.com/artk0de/TeaRAGs-MCP/commit/4e4cdbf))
- refactor(contracts): finalize RerankPreset — remove tool, require tools[] and
  overlayMask ([77b36f6](https://github.com/artk0de/TeaRAGs-MCP/commit/77b36f6))
- refactor(contracts): remove derived from overlay, flatten raw to file/chunk
  ([b59e5f5](https://github.com/artk0de/TeaRAGs-MCP/commit/b59e5f5))
- refactor(contracts): update DerivedSignalDescriptor.extract() to (rawSignals,
  ctx?) ([8305970](https://github.com/artk0de/TeaRAGs-MCP/commit/8305970))
- refactor(reranker): move confidence dampening into descriptors
  ([4069f7a](https://github.com/artk0de/TeaRAGs-MCP/commit/4069f7a))
- refactor(reranker): move dampeningSource from trajectory-level to per-signal
  DerivedSignalDescriptor
  ([f299a06](https://github.com/artk0de/TeaRAGs-MCP/commit/f299a06))
- refactor(reranker): per-source adaptive bounds, fix all derived signal sources
  ([1b9dbc6](https://github.com/artk0de/TeaRAGs-MCP/commit/1b9dbc6))
- refactor(search): address code review — import canonical RankingOverlay, guard
  empty git ([18405b3](https://github.com/artk0de/TeaRAGs-MCP/commit/18405b3))
- refactor(search): consolidate types — remove duplication from reranker.ts
  ([a370253](https://github.com/artk0de/TeaRAGs-MCP/commit/a370253))
- refactor(search): DampeningConfig DI — remove trajectory-specific hardcode
  from Reranker
  ([cf21672](https://github.com/artk0de/TeaRAGs-MCP/commit/cf21672))
- refactor(search): delegate git filters to TrajectoryRegistry.buildFilter()
  ([fbe22c8](https://github.com/artk0de/TeaRAGs-MCP/commit/fbe22c8))
- refactor(search): extract structural signals into individual classes
  ([c9322c9](https://github.com/artk0de/TeaRAGs-MCP/commit/c9322c9))
- refactor(search): generic Reranker with PayloadSignalDescriptor[] and
  dot-notation
  ([cfff0a5](https://github.com/artk0de/TeaRAGs-MCP/commit/cfff0a5))
- refactor(search): remove facade functions, fix domain boundary, simplify
  constructor ([73835d6](https://github.com/artk0de/TeaRAGs-MCP/commit/73835d6))
- refactor(search): support tools[] matching and overlay mask in Reranker
  ([8724c8f](https://github.com/artk0de/TeaRAGs-MCP/commit/8724c8f))
- refactor(search): update preset resolution for tools[] array
  ([1b0b0b3](https://github.com/artk0de/TeaRAGs-MCP/commit/1b0b0b3))
- refactor(search): wire resolved presets into Reranker via optional DI
  ([92a0fa8](https://github.com/artk0de/TeaRAGs-MCP/commit/92a0fa8))
- refactor(trajectory): convert gitSignals to gitPayloadSignalDescriptors
  ([927d915](https://github.com/artk0de/TeaRAGs-MCP/commit/927d915))
- refactor(trajectory): extract git derived signals into individual classes
  ([e27517b](https://github.com/artk0de/TeaRAGs-MCP/commit/e27517b))
- refactor(trajectory): extract preset classes with overlay masks
  ([51e9413](https://github.com/artk0de/TeaRAGs-MCP/commit/51e9413))
- refactor(trajectory): move TrajectoryRegistry to trajectory/index.ts
  ([8429bf4](https://github.com/artk0de/TeaRAGs-MCP/commit/8429bf4))
- refactor(trajectory): rename signals.ts → payload-signals.ts, add stats to all
  numeric signals
  ([531599b](https://github.com/artk0de/TeaRAGs-MCP/commit/531599b))
- docs: add claude rules for payload-signals and rerank-presets
  ([bd12711](https://github.com/artk0de/TeaRAGs-MCP/commit/bd12711))
- docs: add metaOnly git masking design
  ([bf73d23](https://github.com/artk0de/TeaRAGs-MCP/commit/bf73d23))
- docs: signal taxonomy glossary in CLAUDE.md
  ([a02b471](https://github.com/artk0de/TeaRAGs-MCP/commit/a02b471))
- docs: update CLAUDE.md with preset class architecture and derived-signals
  layer ([314ee16](https://github.com/artk0de/TeaRAGs-MCP/commit/314ee16))
- docs: update CLAUDE.md with reranker modularization changes
  ([e79b663](https://github.com/artk0de/TeaRAGs-MCP/commit/e79b663))
- fix(chunker,search): metaOnly fields, 0-line chunks, body chunk merging
  ([215b636](https://github.com/artk0de/TeaRAGs-MCP/commit/215b636))
- fix(bootstrap): remove direct Reranker import, use CompositionResult type
  ([b10833e](https://github.com/artk0de/TeaRAGs-MCP/commit/b10833e))
- fix(chunker): ensure minimum 1-line span for single-line AST nodes
  ([45abfe8](https://github.com/artk0de/TeaRAGs-MCP/commit/45abfe8))
- fix(contracts): remove non-null assertions in computeCollectionStats
  ([b53b509](https://github.com/artk0de/TeaRAGs-MCP/commit/b53b509))
- fix(filters): correct stale Qdrant keys, add level-aware ageDays/commitCount
  ([eac899d](https://github.com/artk0de/TeaRAGs-MCP/commit/eac899d))
- fix(presets): correct weights/overlays/tools, remove impactAnalysis, DRY
  defaultBound
  ([d3799fa](https://github.com/artk0de/TeaRAGs-MCP/commit/d3799fa))
- fix(reranker): fix chunk-only scoring, onboarding overlay, and adaptive bounds
  ([39b90ce](https://github.com/artk0de/TeaRAGs-MCP/commit/39b90ce))
- fix(trajectory): canonical file._/chunk._ sources, deduplicate chunk signals
  ([da632ac](https://github.com/artk0de/TeaRAGs-MCP/commit/da632ac))
- fix(website): mobile sidebar and TOC broken by CSS containing block
  ([e9e9693](https://github.com/artk0de/TeaRAGs-MCP/commit/e9e9693))
- fix(website): restore search icon and make it gold in dark mode
  ([f5e8201](https://github.com/artk0de/TeaRAGs-MCP/commit/f5e8201)), closes
  [#c5a864](https://github.com/artk0de/TeaRAGs-MCP/issues/c5a864)
  [#333](https://github.com/artk0de/TeaRAGs-MCP/issues/333)
- chore: remove dead code and stale re-exports
  ([9e406f1](https://github.com/artk0de/TeaRAGs-MCP/commit/9e406f1))
- chore(beads): plan reranker infrastructure tasks and techDebt redesign
  ([d296e36](https://github.com/artk0de/TeaRAGs-MCP/commit/d296e36))

## <small>0.5.3 (2026-02-25)</small>

- docs: add chunk metrics and interaction model research documents
  ([8c71159](https://github.com/artk0de/TeaRAGs-MCP/commit/8c71159))
- ci: use RELEASE_TOKEN PAT for semantic-release to trigger CI on release
  commits ([7707697](https://github.com/artk0de/TeaRAGs-MCP/commit/7707697))

## <small>0.5.2 (2026-02-24)</small>

- fix(ci): relaunch ci
  ([2c821b6](https://github.com/artk0de/TeaRAGs-MCP/commit/2c821b6))
- fix(ci): remove [skip ci] from semantic-release to fix Codecov coverage
  tracking ([1cab357](https://github.com/artk0de/TeaRAGs-MCP/commit/1cab357))

## <small>0.5.1 (2026-02-24)</small>

- refactor: remove dead git field from ChunkItem, fix CI coverage
  ([267a0ab](https://github.com/artk0de/TeaRAGs-MCP/commit/267a0ab))
- ci: merge docs deployment into release pipeline
  ([1ac3905](https://github.com/artk0de/TeaRAGs-MCP/commit/1ac3905))

## 0.5.0 (2026-02-24)

- build: reset versioning to 0.4.0 and add dual changelog output
  ([464e7e3](https://github.com/artk0de/TeaRAGs-MCP/commit/464e7e3))
- fix: make README logo clickable, links to docs site
  ([31f8eeb](https://github.com/artk0de/TeaRAGs-MCP/commit/31f8eeb))
- fix: point all repo links to artk0de/TeaRAGs-MCP
  ([b9edcd7](https://github.com/artk0de/TeaRAGs-MCP/commit/b9edcd7))
- fix: resolve all ESLint issues (329 → 0 problems)
  ([b07f753](https://github.com/artk0de/TeaRAGs-MCP/commit/b07f753))
- fix: update verify-providers.js import path after refactoring
  ([6cbf6c2](https://github.com/artk0de/TeaRAGs-MCP/commit/6cbf6c2))
- fix: use full-size logo in README
  ([3a7c0d2](https://github.com/artk0de/TeaRAGs-MCP/commit/3a7c0d2))
- fix(ci): exclude website tests from main suite, scope docs deploy to
  website/\*\*
  ([7981503](https://github.com/artk0de/TeaRAGs-MCP/commit/7981503))
- fix(website): address code review — deps, ref placement, resetSeenHashes
  ([b980b94](https://github.com/artk0de/TeaRAGs-MCP/commit/b980b94))
- fix(website): correct baseUrl to /TeaRAGs-MCP/ for GitHub Pages
  ([cc74bf4](https://github.com/artk0de/TeaRAGs-MCP/commit/cc74bf4))
- fix(website): dino now reaches chicken before catch bang fires
  ([38310d3](https://github.com/artk0de/TeaRAGs-MCP/commit/38310d3))
- fix(website): use useBaseUrl for logo path in DinoLogo
  ([d6de9fa](https://github.com/artk0de/TeaRAGs-MCP/commit/d6de9fa))
- chore: merge refactor/solid-ingest-pipeline into main
  ([96b62ea](https://github.com/artk0de/TeaRAGs-MCP/commit/96b62ea))
- chore: sync beads from main
  ([fbaf5d5](https://github.com/artk0de/TeaRAGs-MCP/commit/fbaf5d5))
- test: add multi-provider and empty-provider coordinator tests
  ([743a6e1](https://github.com/artk0de/TeaRAGs-MCP/commit/743a6e1))
- test: restructure tests to mirror src/ and raise coverage to 95%
  ([be7a4d9](https://github.com/artk0de/TeaRAGs-MCP/commit/be7a4d9))
- refactor: decompose EnrichmentModule into coordinator + chunk-churn +
  metadata-applier
  ([6000857](https://github.com/artk0de/TeaRAGs-MCP/commit/6000857))
- refactor: decompose src/ into bootstrap/core/mcp domain layers (SRP)
  ([e100933](https://github.com/artk0de/TeaRAGs-MCP/commit/e100933))
- refactor: delete deprecated git-metadata-service and blame types
  ([8c8650a](https://github.com/artk0de/TeaRAGs-MCP/commit/8c8650a))
- refactor: extract basic git operations to adapters/git/ layer
  ([14db196](https://github.com/artk0de/TeaRAGs-MCP/commit/14db196))
- refactor: extract chunk-reader from git-log-reader, move pathspec to adapters
  ([33d1c66](https://github.com/artk0de/TeaRAGs-MCP/commit/33d1c66))
- refactor: extract EnrichmentProvider interface and extractTaskIds to
  enrichment/ ([919d6f3](https://github.com/artk0de/TeaRAGs-MCP/commit/919d6f3))
- refactor: extract file-reader from git-log-reader
  ([257ce77](https://github.com/artk0de/TeaRAGs-MCP/commit/257ce77))
- refactor: extract git enrichment cache to enrichment/git/cache.ts
  ([81f707a](https://github.com/artk0de/TeaRAGs-MCP/commit/81f707a))
- refactor: extract infrastructure from orchestrators (Phase 6)
  ([80153bb](https://github.com/artk0de/TeaRAGs-MCP/commit/80153bb))
- refactor: extract pure metrics to enrichment/git/metrics.ts
  ([497f42e](https://github.com/artk0de/TeaRAGs-MCP/commit/497f42e))
- refactor: extract shared lifecycle into BaseIndexingPipeline (Phase 5)
  ([f5bb62d](https://github.com/artk0de/TeaRAGs-MCP/commit/f5bb62d))
- refactor: inject dependencies via IngestDependencies factory (Phase 5b)
  ([36d8a31](https://github.com/artk0de/TeaRAGs-MCP/commit/36d8a31))
- refactor: layer git types and move GitLogReader into enrichment domain
  ([76d525c](https://github.com/artk0de/TeaRAGs-MCP/commit/76d525c))
- refactor: make EnrichmentCoordinator multi-provider with ProviderState map
  ([1e1adb6](https://github.com/artk0de/TeaRAGs-MCP/commit/1e1adb6))
- refactor: move enrichment into pipeline/, git into
  pipeline/enrichment/trajectory/git/
  ([6301ee4](https://github.com/artk0de/TeaRAGs-MCP/commit/6301ee4))
- refactor: move git/ and enrichment/ into ingest/trajectory/ domain (Phase 8)
  ([1582fce](https://github.com/artk0de/TeaRAGs-MCP/commit/1582fce))
- refactor: move status-module and indexing-marker into pipeline/
  ([2cfb1e2](https://github.com/artk0de/TeaRAGs-MCP/commit/2cfb1e2))
- refactor: remove hardcoded git payload from ChunkPipeline
  ([51dfe9e](https://github.com/artk0de/TeaRAGs-MCP/commit/51dfe9e))
- refactor: remove isomorphic-git heavy fallbacks to prevent OOM on large repos
  ([f28cbf7](https://github.com/artk0de/TeaRAGs-MCP/commit/f28cbf7))
- refactor: reorganize pipeline/ into infra/, chunker/infra/, chunker/utils/
  ([8f97197](https://github.com/artk0de/TeaRAGs-MCP/commit/8f97197))
- refactor: restructure ingest/ domain layout
  ([7596072](https://github.com/artk0de/TeaRAGs-MCP/commit/7596072))
- refactor: SOLID cleanup of ingest domain — facades, Template Method, DRY
  ([29612a1](https://github.com/artk0de/TeaRAGs-MCP/commit/29612a1))
- refactor: wire EnrichmentCoordinator, nested payload, delete old modules
  ([ab65bae](https://github.com/artk0de/TeaRAGs-MCP/commit/ab65bae))
- refactor: wire EnrichmentRegistry into IngestFacade, remove git guards from
  base ([f3397c2](https://github.com/artk0de/TeaRAGs-MCP/commit/f3397c2))
- feat: add createEnrichmentProviders registry factory
  ([901acf9](https://github.com/artk0de/TeaRAGs-MCP/commit/901acf9))
- feat: create generic EnrichmentApplier with nested payload structure
  ([0b4d785](https://github.com/artk0de/TeaRAGs-MCP/commit/0b4d785))
- feat: create generic EnrichmentCoordinator with provider interface
  ([27cf0dd](https://github.com/artk0de/TeaRAGs-MCP/commit/27cf0dd))
- feat: create GitEnrichmentProvider implementing EnrichmentProvider interface
  ([89fa2a3](https://github.com/artk0de/TeaRAGs-MCP/commit/89fa2a3))
- feat(website): add Docusaurus documentation site with unified signal naming
  ([a2c9efc](https://github.com/artk0de/TeaRAGs-MCP/commit/a2c9efc))
- docs: condense README with emojis and trimmed docs table
  ([0cd340f](https://github.com/artk0de/TeaRAGs-MCP/commit/0cd340f))
- docs: multi-provider enrichment architecture design
  ([8d03350](https://github.com/artk0de/TeaRAGs-MCP/commit/8d03350))
- docs: multi-provider enrichment implementation plan
  ([7ac870f](https://github.com/artk0de/TeaRAGs-MCP/commit/7ac870f))
- docs: trajectory enrichment redesign plan
  ([6cafd0c](https://github.com/artk0de/TeaRAGs-MCP/commit/6cafd0c))
