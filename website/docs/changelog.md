---
title: Changelog
sidebar_position: 99
---

## [1.17.3](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.17.2...v1.17.3) (2026-03-30)

### Bug Fixes

- **dx:** use relative source paths in marketplace.json, fix ENAMETOOLONG on
  plugin update
  ([eac2343](https://github.com/artk0de/TeaRAGs-MCP/commit/eac2343594b1cbbd3dc8461db16c8d2295c0d644))

## [1.17.2](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.17.1...v1.17.2) (2026-03-30)

### Improvements

- **plugin:** merge research into explore, add baseline-first eval to
  optimize-skill
  ([ffc6c42](https://github.com/artk0de/TeaRAGs-MCP/commit/ffc6c42d45fb1c15ca8a1d1fe72aba982adedc62))
- **plugin:** optimize risk-assessment skill, decouple from DDG chain
  ([3e8c8fe](https://github.com/artk0de/TeaRAGs-MCP/commit/3e8c8fea6a32bff4e2bd689ad777631bb5068fa6))

### Documentation

- **architecture:** add pattern vocabulary design spec
  ([2e47001](https://github.com/artk0de/TeaRAGs-MCP/commit/2e470014affe245d42e6503deab32cc3ee4af3f5))

## [1.17.1](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.17.0...v1.17.1) (2026-03-29)

### Improvements

- **dx:** add skill-creator dependency to optimize-skill, enforce marketplace
  version sync
  ([08cc218](https://github.com/artk0de/TeaRAGs-MCP/commit/08cc218626b5158a33748c31b61fe9aa59f716b8))

## [1.17.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.16.0...v1.17.0) (2026-03-29)

### ⚠ BREAKING CHANGES

- **ingest:** IndexPipeline.indexCodebase() now throws IndexingFailedError
  instead of returning stats with status='failed'. MCP error handler already
  handles typed errors correctly.

Co-Authored-By: Claude Opus 4.6 (1M context) &lt;noreply@anthropic.com&gt;

- **ingest:** IndexPipeline.indexCodebase() now throws IndexingFailedError
  instead of returning stats with status='failed'. MCP error handler already
  handles typed errors correctly.

Co-Authored-By: Claude Opus 4.6 (1M context) &lt;noreply@anthropic.com&gt;

### Features

- **api:** add risk-assessment skill for multi-dimensional code health scan
  ([ba99b7f](https://github.com/artk0de/TeaRAGs-MCP/commit/ba99b7f67d0f40fc060dd0925b22106698ae9b66))
- **ingest:** add IndexingFailedError + wrapUnexpectedError base method
  ([b12eff3](https://github.com/artk0de/TeaRAGs-MCP/commit/b12eff36aa3397ad057541f91b99b5cf6bb3f656))

### Improvements

- **plugin:** optimize explore skill — eval-driven, fix pathPattern + codeReview
  bugs
  ([ef974a0](https://github.com/artk0de/TeaRAGs-MCP/commit/ef974a0e8ee286ef64a52db98c0376d0673baecd))
- **plugin:** refactor search-cascade — modularize, skills-first, eval-driven
  ([2f25288](https://github.com/artk0de/TeaRAGs-MCP/commit/2f252881276c3f6808798ec5109a5bdd596c82f4))
- **plugin:** update risk-assessment skill
  ([4d8df59](https://github.com/artk0de/TeaRAGs-MCP/commit/4d8df593d9f1115adc9afc9631c9266a8315f15b))

### Bug Fixes

- **explore:** apply pathPattern filter in findSimilar via buildMergedFilter
  ([edf1e7b](https://github.com/artk0de/TeaRAGs-MCP/commit/edf1e7bcf874566f2471fab1b8fbec868e76a149))
- **explore:** propagate chunk ID through rank_chunks pipeline
  ([0a01d0f](https://github.com/artk0de/TeaRAGs-MCP/commit/0a01d0f8cc3e4a7312b82bbed1673df3ad0f1a1b))
- **explore:** propagate must_not from pathPattern in findSymbol
  ([3c5dd45](https://github.com/artk0de/TeaRAGs-MCP/commit/3c5dd452c2cd4a09f294619118a9bb90658ed532))
- **explore:** wrap Qdrant 404 as ChunkNotFoundError in find_similar
  ([378ebaa](https://github.com/artk0de/TeaRAGs-MCP/commit/378ebaaca5badf0782a2ebb39441bd4426253d64))
- **ingest:** harden risk zones — daemon lock, status-module codec, unified
  errors
  ([ef94055](https://github.com/artk0de/TeaRAGs-MCP/commit/ef940550d3505158232d0e3bdc0b64592743fc36))
- **ingest:** unify IndexPipeline error handling, reorder alias-before-marker
  ([65ead0a](https://github.com/artk0de/TeaRAGs-MCP/commit/65ead0acd72df8f20bbdeed2711c7bb0b37ce0fc))
- **pipeline:** stamp enrichedAt on chunks with no git commits
  ([79a762d](https://github.com/artk0de/TeaRAGs-MCP/commit/79a762d28cf76d42b6b36107013fabef6813aa9b))
- **qdrant:** use exact match for pathPattern with literal file paths
  ([2a35062](https://github.com/artk0de/TeaRAGs-MCP/commit/2a3506281349c009cddd0a42d9700df48b3ed1e4))

### Documentation

- **ingest:** add reindexing decomposition spec and implementation plan
  ([47a8a8b](https://github.com/artk0de/TeaRAGs-MCP/commit/47a8a8b6706b23aa73e7e33317ca1d1968d4eb43))
- **plans:** add ingest risk zones hardening implementation plan
  ([7719f9a](https://github.com/artk0de/TeaRAGs-MCP/commit/7719f9a3b25e6b5938c038f8e63f2c49b50dc93a))
- **specs:** add ingest risk zones hardening design
  ([f825eec](https://github.com/artk0de/TeaRAGs-MCP/commit/f825eec4190bf21e312aecef5a7fa54bc6df6eca))

## [1.16.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.15.1...v1.16.0) (2026-03-29)

### ⚠ BREAKING CHANGES

- **deps:** zod upgraded from v3 to v4. Users extending MCP tool schemas must
  use z.record(z.string(), valueSchema) instead of z.record(valueSchema). No
  changes needed for MCP tool consumers.

Co-Authored-By: Claude Opus 4.6 (1M context) &lt;noreply@anthropic.com&gt;

- **deps:** Minimum Node.js version remains 22, but .tool-versions now defaults
  to 24.14.1. Users on Node 22 are unaffected. tree-sitter dependency now
  resolves to @artk0de/tree-sitter fork with prebuilt native binaries — no
  CXXFLAGS or compilation required.

Co-Authored-By: Claude Opus 4.6 (1M context) &lt;noreply@anthropic.com&gt;

- **enrichment:** EnrichmentInfo and ChunkEnrichmentInfo removed.
  IndexStatus.enrichment is now Record&lt;string, EnrichmentProviderHealth&gt;.
  IndexStatus.chunkEnrichment removed.

Co-Authored-By: Claude Opus 4.6 (1M context) &lt;noreply@anthropic.com&gt;

- **api:** get_index_metrics signals format changed from Record&lt;signalKey,
  SignalMetrics&gt; to Record&lt;language, Record&lt;signalKey,
  SignalMetrics&gt;&gt;. Global stats are now under signals["global"].
  Per-language stats under signals["typescript"] etc. Consumers must update to
  access signals.global instead of signals directly.

Co-Authored-By: Claude Opus 4.6 (1M context) &lt;noreply@anthropic.com&gt;

### Features

- **api:** add find_symbol MCP tool — LSP-like symbol lookup
  ([810eb52](https://github.com/artk0de/TeaRAGs-MCP/commit/810eb5233e7337cb26805dcaeb020db23b2828ec))
- **api:** add infraHealth to get_index_status + auto-cleanup stale markers
  ([3c13bcd](https://github.com/artk0de/TeaRAGs-MCP/commit/3c13bcdff1e6d958713ec78585c0337235bc19f0))
- **api:** add infraHealth to get_index_status + auto-cleanup stale markers
  ([5e02ebd](https://github.com/artk0de/TeaRAGs-MCP/commit/5e02ebd3bbad094d10a2bad62d3beae5f05c7591))
- **api:** per-language signal statistics
  ([e967864](https://github.com/artk0de/TeaRAGs-MCP/commit/e9678640ae56ef654b496ea17140b1dd524a35ce))
- **api:** per-language signals in get_index_metrics response
  ([7a737ea](https://github.com/artk0de/TeaRAGs-MCP/commit/7a737ea98f820fa491f203de0111d48a7369125d))
- **api:** scoped signal metrics in get_index_metrics output
  ([2636794](https://github.com/artk0de/TeaRAGs-MCP/commit/26367947ec7e36d7867393478b6c866179ddb0b2))
- **chunker:** add RSpec scope-centric chunking with parent setup injection
  ([2ad5cd3](https://github.com/artk0de/TeaRAGs-MCP/commit/2ad5cd344dc8e6ab0341d5cb9596ad3a466e8126))
- **chunker:** add RSpec scope-centric chunking with parent setup injection
  ([6a119a2](https://github.com/artk0de/TeaRAGs-MCP/commit/6a119a2bc4d9723fe2f5ff8ea256a9b43e3a2d53))
- **cli:** add tea-rags tune command
  ([7d4a550](https://github.com/artk0de/TeaRAGs-MCP/commit/7d4a550cd2420131b1cff0621abbccf429ae31f6))
- **contracts:** add perLanguage to CollectionSignalStats type
  ([97856a5](https://github.com/artk0de/TeaRAGs-MCP/commit/97856a5dca403b21de43d28b83ea8d5b77e9cc9a))
- **contracts:** add ScopedSignalStats type, CODE_TEST_PATHS config, and v5
  cache
  ([cbc20ef](https://github.com/artk0de/TeaRAGs-MCP/commit/cbc20efa76579b848ebb484b2a6fcdd09faf03c5))
- **dx:** add /tea-rags-setup:tune skill, remove tune scripts
  ([8f9c073](https://github.com/artk0de/TeaRAGs-MCP/commit/8f9c073459036f35888a35e2ab6456ad4b315381))
- **dx:** add node, tea-rags, and ollama install scripts (unix)
  ([64ae330](https://github.com/artk0de/TeaRAGs-MCP/commit/64ae330b6f2da060e3985a6e29d1b0b5f83cabf6))
- **dx:** add qdrant, tune, analyze, and configure scripts (unix)
  ([c25ccec](https://github.com/artk0de/TeaRAGs-MCP/commit/c25ccec3bd25b05682a2f1197f189e0ff1b78e28))
- **dx:** add setup progress CRUD script (unix)
  ([b9c750a](https://github.com/artk0de/TeaRAGs-MCP/commit/b9c750aeee5f87aa34501fc1df051cd13e8f0d97))
- **dx:** add setup scripts (windows)
  ([63aa8c6](https://github.com/artk0de/TeaRAGs-MCP/commit/63aa8c6c0821f611d1e4db724bb6c2aa37420b21))
- **dx:** add setup skill orchestrator (SKILL.md)
  ([c812177](https://github.com/artk0de/TeaRAGs-MCP/commit/c81217736139fd20f488df512538116d58a3e2e4))
- **embedded:** auto-reconnect to Qdrant daemon on port change
  ([d893617](https://github.com/artk0de/TeaRAGs-MCP/commit/d893617bb6c04c06516b1e529f6b7b1ef7df8306))
- **enrichment:** add enrichedAt migration for existing collections
  ([e1d2848](https://github.com/artk0de/TeaRAGs-MCP/commit/e1d28489c58451b928c4ddd01c58c2fa47ee621e))
- **enrichment:** add enrichment health to get_index_metrics output
  ([949be11](https://github.com/artk0de/TeaRAGs-MCP/commit/949be1110855eafb58a56dbe2c5802c12e47e46f))
- **enrichment:** add EnrichmentRecovery module for unenriched chunk detection
  and re-enrichment
  ([6a448ff](https://github.com/artk0de/TeaRAGs-MCP/commit/6a448ff9559209789970c6d11b8d73d161eebac7))
- **enrichment:** add health mapper with stale detection for StatusModule
  ([f7be1c9](https://github.com/artk0de/TeaRAGs-MCP/commit/f7be1c9148ef00be2d56e2aaa07dba07d1f766cc))
- **enrichment:** enrichment failure recovery with per-provider health tracking
  ([b30f64a](https://github.com/artk0de/TeaRAGs-MCP/commit/b30f64a86c392305ff8b0389e15f967f91f3bc28))
- **enrichment:** per-level marker updates with heartbeat in coordinator
  ([923b628](https://github.com/artk0de/TeaRAGs-MCP/commit/923b62843a1af4c7333d1b77a5e226cc5ad63573))
- **enrichment:** replace flat EnrichmentInfo with per-provider health types
  ([f34751c](https://github.com/artk0de/TeaRAGs-MCP/commit/f34751c97c6b0a625b86fd1a750a86bcdbc9360c))
- **enrichment:** wire recovery and migration into indexing pipeline
  ([271b4e3](https://github.com/artk0de/TeaRAGs-MCP/commit/271b4e3246acb3ad764cb51593fe8431b4514ca4))
- **enrichment:** write enrichedAt timestamps in applier batch payloads
  ([3b881a3](https://github.com/artk0de/TeaRAGs-MCP/commit/3b881a32ba8b3eb45cb76a5153ed3d096ff7f630))
- **explore:** add ExploreFacade.findSymbol() with scroll + resolve pipeline
  ([19e9df4](https://github.com/artk0de/TeaRAGs-MCP/commit/19e9df4e929cfa827b6f7a7c736692a2be723728))
- **explore:** add symbol-resolve.ts with merge and outline strategies
  ([dfda4b9](https://github.com/artk0de/TeaRAGs-MCP/commit/dfda4b92373666a0285ac3a3f51f6d9775019ade))
- **filters:** add symbolId filter with text index and partial match
  ([c038f2e](https://github.com/artk0de/TeaRAGs-MCP/commit/c038f2eb0b168728482556e66d3aa30581f5b86a))
- **infra:** add detectScope() utility for test/source classification
  ([57e8d1f](https://github.com/artk0de/TeaRAGs-MCP/commit/57e8d1fb129762f9cfe158109ab6bea6545de69b))
- **infra:** add migration framework — Migrator, Migration interface, types
  ([6416a71](https://github.com/artk0de/TeaRAGs-MCP/commit/6416a712d18a222b6135c4b8c3ad980bd9560a3c))
- **infra:** add SnapshotMigrator and snapshot migration classes
  ([72ffee2](https://github.com/artk0de/TeaRAGs-MCP/commit/72ffee23ef12235d69e9714e4579feabbe807458))
- **ingest:** add per-provider per-level enrichment marker types
  ([8632769](https://github.com/artk0de/TeaRAGs-MCP/commit/8632769f3a4f85a9f0c16a00c7a124218c243fd5))
- **ingest:** compute per-language signal statistics
  ([bb470e7](https://github.com/artk0de/TeaRAGs-MCP/commit/bb470e73c9a5fe566c72e60b99b6175186d030d3))
- **ingest:** scope-aware signal stats computation (source vs test)
  ([c63a161](https://github.com/artk0de/TeaRAGs-MCP/commit/c63a161c3e5f3756524f3148047d1d6d0c676063))
- **mcp:** health-aware error interceptor with infra context
  ([1ebb68e](https://github.com/artk0de/TeaRAGs-MCP/commit/1ebb68e91dc32a1b09decd6eaa8a89b7087efd16))
- **mcp:** health-aware error interceptor with infra context
  ([e1deef2](https://github.com/artk0de/TeaRAGs-MCP/commit/e1deef286e60fc674591cd510998f886bb63aaa8))
- **mcp:** register find_symbol tool with Zod schema
  ([dccc9a7](https://github.com/artk0de/TeaRAGs-MCP/commit/dccc9a7c23bb7a6902601feaf2d71bb4fd4988b9))
- **qdrant:** add QdrantManager.scrollFiltered() for filter-based scroll
  ([d1e2159](https://github.com/artk0de/TeaRAGs-MCP/commit/d1e2159c3b958389b1b20f65ae250377aff39e1c))
- **rerank:** scope-aware label resolution (source vs test thresholds)
  ([0c91455](https://github.com/artk0de/TeaRAGs-MCP/commit/0c91455069794fce6d0098ab444c06750d599bb7))
- **scripts:** abstract embedding provider for Ollama/ONNX support
  ([2c48d48](https://github.com/artk0de/TeaRAGs-MCP/commit/2c48d486101bff502147a0a94a18effd51af2c11))
- **scripts:** add --path arg and test values for new benchmark params
  ([17573b3](https://github.com/artk0de/TeaRAGs-MCP/commit/17573b3a4299021949d8b982aa1c3a7d5580e7bc))
- **scripts:** add benchmark functions for pipeline, qdrant gaps, and git
  trajectory
  ([dc720d8](https://github.com/artk0de/TeaRAGs-MCP/commit/dc720d8b27449b4ffe121de715b62b29f22cbc00))
- **scripts:** add file collector for benchmark corpus
  ([27fe55a](https://github.com/artk0de/TeaRAGs-MCP/commit/27fe55a2bbaa6eb91b6b494f255fe4e2f7999719))
- **scripts:** add new params to benchmark output
  ([5a66096](https://github.com/artk0de/TeaRAGs-MCP/commit/5a6609676bd7a773c0f33172f2eb1e457cccf43f))
- **scripts:** benchmark expansion — pipeline, git trajectory, ONNX, CLI tune
  command
  ([1d490c8](https://github.com/artk0de/TeaRAGs-MCP/commit/1d490c85f00cc6ef9c3cc7c30a24d0f835e7aea9))
- **scripts:** integrate git trajectory benchmarks into tune.mjs
  ([0e67210](https://github.com/artk0de/TeaRAGs-MCP/commit/0e6721020261643df2aed49fea0d4c7f091c5cc9))
- **scripts:** integrate pipeline + qdrant gap benchmarks into tune.mjs
  ([98d20b1](https://github.com/artk0de/TeaRAGs-MCP/commit/98d20b1d35c83b6bf01b68997796071b430239e9))

### Improvements

- **cli:** add --qdrant-url, --embedding-url, --model, --provider params to tune
  command
  ([918633c](https://github.com/artk0de/TeaRAGs-MCP/commit/918633ca81ecfc568036802541be130d04d0356e))
- **cli:** add tune embeddings subcommand, fix provider display, remove device
  restrictions
  ([cfc693a](https://github.com/artk0de/TeaRAGs-MCP/commit/cfc693a998fa8c63c72486088803b1a1443edb9c))
- **dx:** add subagent tea-rags injection rule to search-cascade
  ([99c9b54](https://github.com/artk0de/TeaRAGs-MCP/commit/99c9b5424825dacb133787e0f662d686c77bdcbd))
- **dx:** add subagent tea-rags injection rule to search-cascade
  ([54a1b8a](https://github.com/artk0de/TeaRAGs-MCP/commit/54a1b8a5b8c27c2f8f7c43d6c25d6a8cc567951e))
- **dx:** add subagent tea-rags injection rule to search-cascade
  ([13b3c79](https://github.com/artk0de/TeaRAGs-MCP/commit/13b3c797fc7ac37af8bf0fec490898e4a4364ee6))
- **dx:** emphasize duration field in index/force-reindex skill prompts
  ([c6310bd](https://github.com/artk0de/TeaRAGs-MCP/commit/c6310bd8994629436e2b51c45bccff6e17f913f6))
- **dx:** enhance migration rule frontmatter, fix skill templates
  ([610ef09](https://github.com/artk0de/TeaRAGs-MCP/commit/610ef09b1d59dc1a59cf5ba8a950714e5b54cf85))
- **dx:** harden install wizard — cross-platform fixes, decompose SKILL.md
  ([a727edd](https://github.com/artk0de/TeaRAGs-MCP/commit/a727edd1cd27234db04afbb7cd691ecebf3366a5))
- **dx:** inject tea-rags search rules into subagent prompts via PreToolUse hook
  ([2368987](https://github.com/artk0de/TeaRAGs-MCP/commit/2368987c9bb169fe091e6cc0cef80be1019e9d2c))
- **dx:** inject tea-rags search rules into subagent prompts via PreToolUse hook
  ([3270062](https://github.com/artk0de/TeaRAGs-MCP/commit/3270062492d70cf3d3560e34edf96561b21b7ddf))
- **dx:** replace configure-mcp scripts with MCP integrator agent
  ([a5da1f0](https://github.com/artk0de/TeaRAGs-MCP/commit/a5da1f0cc29222381027545f6ffb43854efccde4))
- **dx:** require explicit user confirmation for force-reindex skill
  ([40afa1d](https://github.com/artk0de/TeaRAGs-MCP/commit/40afa1d316a3a9650b58c68c0d74f6fb24166df0))
- **dx:** require explicit user confirmation for force-reindex skill
  ([c55718d](https://github.com/artk0de/TeaRAGs-MCP/commit/c55718db28f6a24cf59aee8791cdc14a1d64cbde))
- **dx:** update skills for per-language signals format
  ([33f7d74](https://github.com/artk0de/TeaRAGs-MCP/commit/33f7d745eed0c05751aa3bcd635068f8434af551))
- **ingest:** add 'code' (fenced blocks from markdown) to config languages
  ([ec18c11](https://github.com/artk0de/TeaRAGs-MCP/commit/ec18c113928f48845c5b54932378f15c79b1dcfc))
- **ingest:** exclude config languages (markdown, bash, json, etc.) from
  per-language stats
  ([e9c33bd](https://github.com/artk0de/TeaRAGs-MCP/commit/e9c33bd8d9e5e56fa52fefb7c4ac998f43cc0e26))
- **ingest:** exclude config languages from global, hide global if mono-lang
  ([b601fde](https://github.com/artk0de/TeaRAGs-MCP/commit/b601fdec8b4c11521c9bfea358be5fc11978ccf4))
- **mcp:** add limit/offset to find_symbol for pagination
  ([e8f81ec](https://github.com/artk0de/TeaRAGs-MCP/commit/e8f81ece9b71dbec3fe8de60d7b7c291608ef519))
- **mcp:** add metaOnly to find_symbol, update plugin skills
  ([4fc6095](https://github.com/artk0de/TeaRAGs-MCP/commit/4fc609592aa93e768b882a061e682386c9b515ae))
- **mcp:** add rerank parameter to find_symbol for ranking overlays
  ([e0f83b9](https://github.com/artk0de/TeaRAGs-MCP/commit/e0f83b9aa415064b1a4629f237acf2450c77707f))
- **mcp:** clean up TODO markers in enrichment output formatters
  ([f2cb4be](https://github.com/artk0de/TeaRAGs-MCP/commit/f2cb4be4cf8754bccdb466862010e28ae36b6bbe))
- **qdrant:** cap scrollFiltered total results at limit parameter
  ([215c6f2](https://github.com/artk0de/TeaRAGs-MCP/commit/215c6f2f0b0380522325bf7845fa14d355111c32))
- **rerank:** labels only for code languages in perLanguage, no global fallback
  ([9f81f6b](https://github.com/artk0de/TeaRAGs-MCP/commit/9f81f6b561bf33edc12d5404b7b719f571432eb8))

### Bug Fixes

- **api:** add missing FindSymbolRequest DTO and barrel export
  ([b41dd91](https://github.com/artk0de/TeaRAGs-MCP/commit/b41dd910437fa7518ca60c7c056d132ed2f499d7))
- **benchmarks:** update import paths after project restructuring
  ([27c55d9](https://github.com/artk0de/TeaRAGs-MCP/commit/27c55d9d65c342ab956b80179e9944e3beb0ef15))
- **chunker:** fix RSpec scope chunking and expand signal coverage
  ([76ac375](https://github.com/artk0de/TeaRAGs-MCP/commit/76ac375416d27eb2a37de0e9b47ffbc7f83ee3be))
- **dx:** correct plugin version to 0.11.0
  ([3b639db](https://github.com/artk0de/TeaRAGs-MCP/commit/3b639db8ccb0da2ea52dddf25ce50210ef7dd1df))
- **embedding:** add health probe before embed to fix cold-start timeout
  ([1e9e6ed](https://github.com/artk0de/TeaRAGs-MCP/commit/1e9e6ed865c6968d39d4c65ebfeb68779e00a4b4))
- **embedding:** add health probe before embed to fix cold-start timeout
  ([b2a52ac](https://github.com/artk0de/TeaRAGs-MCP/commit/b2a52ac887c4c48829577757db66db8bb76475e1))
- **enrichment:** use \_type filter instead of has_id to exclude metadata points
  in recovery scroll
  ([8a4742b](https://github.com/artk0de/TeaRAGs-MCP/commit/8a4742bbd29be0e47b52c6f832e03a1056c4c434))
- **explore:** detect class from residual block with parentType
  ([b31fe43](https://github.com/artk0de/TeaRAGs-MCP/commit/b31fe438624af62ea56d7358a6c012cc81f6215a))
- **explore:** detect class from residual block with
  parentType=class_declaration
  ([9e011ee](https://github.com/artk0de/TeaRAGs-MCP/commit/9e011ee9dcb4e63173ce9ff9308c67dcc6fa5b8e))
- **ingest:** cleanup stale \_vN when legacy real collection or alias exists
  ([cabc89c](https://github.com/artk0de/TeaRAGs-MCP/commit/cabc89c3ecf5be7ae561d41467558abfc6262bf0))
- **ingest:** cleanup stale \_vN when legacy real collection or alias exists
  ([6b38f37](https://github.com/artk0de/TeaRAGs-MCP/commit/6b38f37d6879935e376c0d44eefbecbe1bd3095a))
- **ingest:** delete chunks for newly ignored files during incremental reindex
  ([6ff33cf](https://github.com/artk0de/TeaRAGs-MCP/commit/6ff33cfa6a43a84f672cbbc1a1816af5585c8704))
- **ingest:** heartbeat-based stale detection + remove embedding check from
  getIndexStatus
  ([84e0dd6](https://github.com/artk0de/TeaRAGs-MCP/commit/84e0dd645f77ad11632dbddeef7a64fa3129147f))
- **ingest:** heartbeat-based stale detection + remove embedding check from
  getIndexStatus
  ([c9d4a7c](https://github.com/artk0de/TeaRAGs-MCP/commit/c9d4a7c2356f904fd08f5c65b7653215d5f23787))
- **ingest:** heartbeat-based stale detection + remove embedding check from
  getIndexStatus
  ([1ded172](https://github.com/artk0de/TeaRAGs-MCP/commit/1ded172d5b922f64db4808f87e65213885ae2fb0))
- **ingest:** resolve versioned collection status + batch timeout
  ([24e71ae](https://github.com/artk0de/TeaRAGs-MCP/commit/24e71aeeb1b3d348c6e636c0250896b361ae8cb3))
- **ingest:** resolve versioned collection status + batch timeout
  ([4bfd471](https://github.com/artk0de/TeaRAGs-MCP/commit/4bfd471f78a6118c3e2e4c1e69914786b78f1989))
- **ingest:** resolve versioned collection status + batch timeout
  ([daa4ccb](https://github.com/artk0de/TeaRAGs-MCP/commit/daa4ccbcf4947dfcf87c47336285c9f6c8ced5ae))
- **mcp:** omit driftWarning from structured output when null
  ([7c8f5a5](https://github.com/artk0de/TeaRAGs-MCP/commit/7c8f5a5702dce736176340ad1495be1c12502ce3))
- **migration:** SparseVectorRebuild version 2 → 1 to match
  CURRENT_SPARSE_VERSION
  ([c06bb9d](https://github.com/artk0de/TeaRAGs-MCP/commit/c06bb9d0be427b47a8e536b7d2298b3f8981be55))
- **migration:** use \_type filter in enrichment store adapter, add empty
  collection guard in v9
  ([474d6bb](https://github.com/artk0de/TeaRAGs-MCP/commit/474d6bb6c6b8149ff16a4cd89e0f843bb1618b39))
- **onnx:** auto-detect device, fix socket path, add connect keepalive,
  terminate on exit
  ([d024261](https://github.com/artk0de/TeaRAGs-MCP/commit/d0242610649c47e6d2155474dc884c48abae4c15))
- **qdrant:** centralize connection error handling via call() guard
  ([1e1e134](https://github.com/artk0de/TeaRAGs-MCP/commit/1e1e1341a7b6cf71c75e62ceee9db12fcd2c45c1))
- **qdrant:** centralize connection error handling via call() guard
  ([677694e](https://github.com/artk0de/TeaRAGs-MCP/commit/677694e96a06a33786a1a27c7c999960bb010e00))
- **rerank:** per-language + level-aware label resolution in overlay
  ([c06b941](https://github.com/artk0de/TeaRAGs-MCP/commit/c06b941fc3ce8e15aae076f2added9ee071650d6))
- **rerank:** skip label resolution for config languages in overlay
  ([a887136](https://github.com/artk0de/TeaRAGs-MCP/commit/a887136f4b3a2f5e0227691fbf46490af02bbacc))
- **scripts:** align QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS key between tune and
  output
  ([38120ba](https://github.com/artk0de/TeaRAGs-MCP/commit/38120ba1a0f87072d09dbee33a22b0104f551f7d))
- **scripts:** correct import paths in benchmarks/lib/ (../../build not
  ../build)
  ([3a6f9cf](https://github.com/artk0de/TeaRAGs-MCP/commit/3a6f9cf5617a800319b88a01c5a3cce55fe4cc39))
- **scripts:** use ONNX default model name instead of Ollama model name
  ([78ee713](https://github.com/artk0de/TeaRAGs-MCP/commit/78ee71368345df43e75ab18ea1071cd019d5c183))
- **test:** add retry and timeout to flakey GitLogReader integration tests
  ([bca75ca](https://github.com/artk0de/TeaRAGs-MCP/commit/bca75ca3bcbee13ba4169659209f6a6d0a1797e6))
- **test:** add retry and timeout to flakey GitLogReader integration tests
  ([0371422](https://github.com/artk0de/TeaRAGs-MCP/commit/0371422e782ebb4c6b333c47b27754a669ee110d))
- **test:** update ingest-facade mocks for enrichment recovery wiring
  ([b9bb104](https://github.com/artk0de/TeaRAGs-MCP/commit/b9bb104dd830f004072eb801f7b65006e448f247))

### Documentation

- **api:** add find_symbol design spec
  ([0c9c402](https://github.com/artk0de/TeaRAGs-MCP/commit/0c9c402f24ec3cada6f8cda356f1ec55b8a7b36f))
- **api:** add find_symbol implementation plan
  ([fa3392f](https://github.com/artk0de/TeaRAGs-MCP/commit/fa3392f0300616ff10102db7ac671921202d1cff))
- **api:** add migration framework design spec
  ([0d1044d](https://github.com/artk0de/TeaRAGs-MCP/commit/0d1044ddbea93dd9e039fee7765e621286edcac9))
- **api:** update migration framework spec — remove stats-cache, add file
  structure
  ([5cfd651](https://github.com/artk0de/TeaRAGs-MCP/commit/5cfd651cfc480bd8a637121dbd00b855529c4129))
- **dx:** add migration rule and add-migration skill
  ([f87a894](https://github.com/artk0de/TeaRAGs-MCP/commit/f87a8945f9d15fca6f177bc45b51ae260f10613d))
- **dx:** add plugin restructuring spec
  ([60b547a](https://github.com/artk0de/TeaRAGs-MCP/commit/60b547a4a8b1f3d9f0000104fff1c1d563fea023))
- **dx:** add setup skill spec and implementation plan
  ([779201c](https://github.com/artk0de/TeaRAGs-MCP/commit/779201c070ba7cf4aba8cbe60bd2b3e39d3d17fa))
- **enrichment:** add enrichment recovery design spec
  ([b377994](https://github.com/artk0de/TeaRAGs-MCP/commit/b37799453af1b3b00bc11a96262c3eb1fb971f3a))
- **enrichment:** add enrichment recovery implementation plan
  ([66996df](https://github.com/artk0de/TeaRAGs-MCP/commit/66996df409b8682c65efb481ccb76930e852b314))
- **enrichment:** add heartbeat-based stale detection to recovery spec
  ([7dcb44d](https://github.com/artk0de/TeaRAGs-MCP/commit/7dcb44d4447f12cf90e0e1d88ab807d96ffa2d97))
- **infra:** add migration framework barrel export and update project docs
  ([d77b728](https://github.com/artk0de/TeaRAGs-MCP/commit/d77b7285a86c6b51e2833c7ed91069fe0b5724f0))
- **infra:** add migration framework implementation plan
  ([6e9ee50](https://github.com/artk0de/TeaRAGs-MCP/commit/6e9ee50bc8e663e295f6ca45c99b2f03cbae6b56))
- **mcp:** update get_index_metrics docs for scoped signal output
  ([11061ba](https://github.com/artk0de/TeaRAGs-MCP/commit/11061ba35b8d5ae119621fd6c8667a2dcc7e25ec))
- **specs:** per-language signal statistics spec and plan
  ([507abed](https://github.com/artk0de/TeaRAGs-MCP/commit/507abeda41998705914ce679cfcc1358fe989cc2))

### Code Refactoring

- **dx:** rename setup plugin to tea-rags-setup
  ([e1aecdc](https://github.com/artk0de/TeaRAGs-MCP/commit/e1aecdcbb0116eb927d8a9d2a93fa5b6e2bc8152))
- **dx:** rename setup skill to install
  ([51169b7](https://github.com/artk0de/TeaRAGs-MCP/commit/51169b712f340246ec35c0711065e71ed982ab55))
- **dx:** split plugin into tea-rags@tea-rags + setup@tea-rags
  ([e649590](https://github.com/artk0de/TeaRAGs-MCP/commit/e6495909986af4b73e00cf8e16cb97aa00fa39d0))
- **infra:** unify migrations into infra/migration framework
  ([d4af2e2](https://github.com/artk0de/TeaRAGs-MCP/commit/d4af2e28ae89d397c4adb62faf4246332547a557))
- **ingest:** remove old migration code replaced by infra/migration framework
  ([fa18e73](https://github.com/artk0de/TeaRAGs-MCP/commit/fa18e73556c9965b4fe236d48b01071341bf95f5))
- **ingest:** wire Migrator into factory and ReindexPipeline
  ([9a0c412](https://github.com/artk0de/TeaRAGs-MCP/commit/9a0c412eccd9dbc3133e6acbfef6142e599304b3))
- **migration:** extract SparseMigrator from SchemaMigrator
  ([dac3173](https://github.com/artk0de/TeaRAGs-MCP/commit/dac3173a4d352ac6f3d58133cbcd95bdb37ae07b))
- **migration:** latestVersion on all runners, rename snapshot migrations
  ([df6fd24](https://github.com/artk0de/TeaRAGs-MCP/commit/df6fd247ba8b6f9c5c77686fc88760a543ab587a))
- **migration:** move enrichedAt backfill to migration framework as schema-v9
  ([372de9d](https://github.com/artk0de/TeaRAGs-MCP/commit/372de9d33cd2649fbe23d63a263d08479cb20183))
- **migration:** move sparse rebuild to
  sparse_migrations/sparse-v1-vector-rebuild
  ([fe707d5](https://github.com/artk0de/TeaRAGs-MCP/commit/fe707d568c154ebc233b47c864dbf1682665fe5c))
- **migration:** remove CURRENT_SPARSE_VERSION hardcode, simplify sparse apply()
  ([26a4b3b](https://github.com/artk0de/TeaRAGs-MCP/commit/26a4b3b63b6e03694be272e129e51adadd6ade47))

### Chores

- **deps:** upgrade major dependencies (openai 6, eslint 10, zod 4)
  ([d7b0d89](https://github.com/artk0de/TeaRAGs-MCP/commit/d7b0d89cd4b192a2517798c246b45a062501e258))
- **deps:** upgrade to Node 24 LTS and bump safe dependencies
  ([ccda0d6](https://github.com/artk0de/TeaRAGs-MCP/commit/ccda0d610b5b22387e64c0a77dc497ec087baae1)),
  closes
  [tree-sitter/node-tree-sitter#276](https://github.com/tree-sitter/node-tree-sitter/issues/276)

## <small>1.15.1 (2026-03-23)</small>

- ([a48e5b0](https://github.com/artk0de/TeaRAGs-MCP/commit/a48e5b0))
- improve(dx): redesign bug-hunt skill + add navigation branch to search-cascade
  ([65cd2ef](https://github.com/artk0de/TeaRAGs-MCP/commit/65cd2ef))

## 1.15.0 (2026-03-22)

- improve(api): expose qdrantUrl in get_index_status response
  ([04ca10a](https://github.com/artk0de/TeaRAGs-MCP/commit/04ca10a))
- improve(dx): optimize bug-hunt skill to reduce unnecessary tool calls
  ([d5c6d8b](https://github.com/artk0de/TeaRAGs-MCP/commit/d5c6d8b))
- improve(dx): require full metrics output in index/force-reindex skills
  ([af8ec5f](https://github.com/artk0de/TeaRAGs-MCP/commit/af8ec5f))
- improve(dx): simplify index/force-reindex skills — report complete response
  as-is ([1d27adf](https://github.com/artk0de/TeaRAGs-MCP/commit/1d27adf))
- improve(dx): update search-cascade with BM25 v3 audit results
  ([6f4c084](https://github.com/artk0de/TeaRAGs-MCP/commit/6f4c084))
- improve(embedding): background probe for primary URL recovery
  ([29f1834](https://github.com/artk0de/TeaRAGs-MCP/commit/29f1834))
- improve(embedding): better hint for OllamaModelMissingError
  ([020195d](https://github.com/artk0de/TeaRAGs-MCP/commit/020195d))
- improve(ingest): address code review — tmpdir() in tests, rename path variable
  ([e828992](https://github.com/artk0de/TeaRAGs-MCP/commit/e828992))
- improve(ingest): wire checkSparseVectorVersion() into runMigrations()
  ([8b7f86c](https://github.com/artk0de/TeaRAGs-MCP/commit/8b7f86c))
- improve(ingest): wire SnapshotCleaner into IndexPipeline.indexCodebase()
  ([b5a0032](https://github.com/artk0de/TeaRAGs-MCP/commit/b5a0032))
- improve(ingest): wire SnapshotCleaner into ReindexPipeline.reindexChanges()
  ([338a29f](https://github.com/artk0de/TeaRAGs-MCP/commit/338a29f))
- fix(api): expose sparseVersion in get_index_status response
  ([ed927f5](https://github.com/artk0de/TeaRAGs-MCP/commit/ed927f5))
- fix(api): pass migrations from reindexChanges through incremental
  indexCodebase
  ([008b6e8](https://github.com/artk0de/TeaRAGs-MCP/commit/008b6e8))
- fix(config): treat BREAKING CHANGE as minor bump, not major
  ([e00da12](https://github.com/artk0de/TeaRAGs-MCP/commit/e00da12))
- fix(dx): add PreToolUse hook to block unauthorized git push
  ([b22c1c4](https://github.com/artk0de/TeaRAGs-MCP/commit/b22c1c4))
- fix(dx): allow summarize in index/force-reindex skill output
  ([b490ffb](https://github.com/artk0de/TeaRAGs-MCP/commit/b490ffb))
- fix(embedding): propagate OllamaModelMissingError without fallback attempt
  ([838965c](https://github.com/artk0de/TeaRAGs-MCP/commit/838965c))
- fix(embedding): run model guard before embed call in all facades
  ([e291820](https://github.com/artk0de/TeaRAGs-MCP/commit/e291820))
- fix(filters): add is_empty guard to age filters for missing chunk fields
  ([49bb006](https://github.com/artk0de/TeaRAGs-MCP/commit/49bb006))
- fix(filters): maxAgeDays/minAgeDays false positives from chunk ageDays=0
  ([98cf09e](https://github.com/artk0de/TeaRAGs-MCP/commit/98cf09e))
- fix(ingest): fix empty debug labels in SnapshotCleaner log output
  ([3b90d4f](https://github.com/artk0de/TeaRAGs-MCP/commit/3b90d4f))
- chore(ci): reduce pre-commit hook output — dot reporter, suppress stderr
  ([c3da3f3](https://github.com/artk0de/TeaRAGs-MCP/commit/c3da3f3))
- chore(ci): reduce pre-commit hook output — dot reporter, suppress stderr
  ([c54e39f](https://github.com/artk0de/TeaRAGs-MCP/commit/c54e39f))
- chore(dx): bump plugin version to 0.8.1
  ([6c95e3b](https://github.com/artk0de/TeaRAGs-MCP/commit/6c95e3b))
- feat(config): default enableHybrid to true
  ([401a259](https://github.com/artk0de/TeaRAGs-MCP/commit/401a259))
- feat(dx): add post-search-validation rule with no-match detection and
  disambiguation
  ([1111b4b](https://github.com/artk0de/TeaRAGs-MCP/commit/1111b4b))
- feat(embedding): add EmbeddingModelGuard to detect model mismatch
  ([27c20e2](https://github.com/artk0de/TeaRAGs-MCP/commit/27c20e2))
- feat(hybrid): rebuild BM25 sparse vectors — code tokenizer, feature hashing,
  TF-only ([e04a58e](https://github.com/artk0de/TeaRAGs-MCP/commit/e04a58e))
- feat(ingest): add SnapshotCleaner for post-indexing artifact cleanup
  ([ea552de](https://github.com/artk0de/TeaRAGs-MCP/commit/ea552de))
- feat(metrics): add git enrichment time range to collection stats
  ([c9d95b1](https://github.com/artk0de/TeaRAGs-MCP/commit/c9d95b1))
- feat(qdrant): add checkSparseVectorVersion and v7 schema migration
  ([1fa242f](https://github.com/artk0de/TeaRAGs-MCP/commit/1fa242f))
- feat(qdrant): add updateCollectionSparseConfig() and scrollWithVectors()
  ([2a90acc](https://github.com/artk0de/TeaRAGs-MCP/commit/2a90acc))
- docs(dx): add embedding model guard spec and test golden rule
  ([d7ed2d3](https://github.com/artk0de/TeaRAGs-MCP/commit/d7ed2d3))
- docs(plans): add snapshot cleanup spec and plan
  ([e656bbb](https://github.com/artk0de/TeaRAGs-MCP/commit/e656bbb))
- docs(plans): add sparse vector migration implementation plan
  ([8c018b8](https://github.com/artk0de/TeaRAGs-MCP/commit/8c018b8))
- docs(specs): add safety net for enableHybrid toggle after schema v7
  ([254ea54](https://github.com/artk0de/TeaRAGs-MCP/commit/254ea54))
- docs(specs): add sparse vector migration and snapshot cleanup specs
  ([eb4d4ca](https://github.com/artk0de/TeaRAGs-MCP/commit/eb4d4ca))
- docs(website): update enableHybrid default to true and migration guidance
  ([0b05b81](https://github.com/artk0de/TeaRAGs-MCP/commit/0b05b81))

### BREAKING CHANGE

- Existing hybrid collections must be reindexed — sparse vectors are
  incompatible with previous vocabulary-based implementation.

Co-Authored-By: Claude Opus 4.6 (1M context) &lt;noreply@anthropic.com&gt;

- footer should not trigger major version bumps for this project. Internal data
  format changes (sparse vectors, migrations) are handled automatically and
  don't break the user-facing API.

Co-Authored-By: Claude Opus 4.6 (1M context) &lt;noreply@anthropic.com&gt;

- INGEST_ENABLE_HYBRID now defaults to true. Existing non-hybrid collections
  auto-migrate on next reindex.

Co-Authored-By: Claude Opus 4.6 (1M context) &lt;noreply@anthropic.com&gt;

## <small>1.14.4 (2026-03-22)</small>

- fix(dx): register check-plugin-version hook in settings.json
  ([237a7c1](https://github.com/artk0de/TeaRAGs-MCP/commit/237a7c1))
- improve(dx): skill audit round 2 — proven weights, taskIds essential,
  disambiguation
  ([b45f0f3](https://github.com/artk0de/TeaRAGs-MCP/commit/b45f0f3))

## <small>1.14.3 (2026-03-21)</small>

- improve(dx): skill audit fixes — polyglot rule, filter levels, stable preset,
  resource DRY
  ([ae9eb9a](https://github.com/artk0de/TeaRAGs-MCP/commit/ae9eb9a))
- improve(plugin): optimize bug-hunt skill for speed and token efficiency
  ([9c2fcf4](https://github.com/artk0de/TeaRAGs-MCP/commit/9c2fcf4))
- fix(dx): add plugin versioning rule and bump to 0.5.1
  ([71d4584](https://github.com/artk0de/TeaRAGs-MCP/commit/71d4584))
- fix(plugin): restore lost rules from bug-hunt pre-cascade version
  ([29a5153](https://github.com/artk0de/TeaRAGs-MCP/commit/29a5153))
- fix(plugin): restore pagination and analytics options in bug-hunt REFINE
  ([32c5390](https://github.com/artk0de/TeaRAGs-MCP/commit/32c5390))
- fix(plugin): restore two-phase search in bug-hunt skill
  ([9280400](https://github.com/artk0de/TeaRAGs-MCP/commit/9280400))
- fix(plugin): skip VERIFY when all checkpoint fields filled in DISCOVER
  ([3e25974](https://github.com/artk0de/TeaRAGs-MCP/commit/3e25974))
- fix(plugin): use metaOnly=false in bug-hunt DISCOVER step
  ([840e892](https://github.com/artk0de/TeaRAGs-MCP/commit/840e892))

## <small>1.14.2 (2026-03-21)</small>

- improve(embedding): platform-aware Ollama hints and RFC1918 local IP detection
  ([0574942](https://github.com/artk0de/TeaRAGs-MCP/commit/0574942))
- ([7cb6705](https://github.com/artk0de/TeaRAGs-MCP/commit/7cb6705))

## <small>1.14.1 (2026-03-21)</small>

- fix(ingest): clear enrichment in_progress marker when no chunks produced
  ([1230e45](https://github.com/artk0de/TeaRAGs-MCP/commit/1230e45))

## 1.14.0 (2026-03-21)

- feat(embedding): add EMBEDDING_FALLBACK_URL for Ollama provider failover
  ([0fe1a88](https://github.com/artk0de/TeaRAGs-MCP/commit/0fe1a88))
- chore(dx): bump plugin version to 0.5.0
  ([bb915ff](https://github.com/artk0de/TeaRAGs-MCP/commit/bb915ff))

## <small>1.13.1 (2026-03-21)</small>

- fix(ingest): preserve enrichment coverage stats on scoped reindex and regroup
  output ([2e73825](https://github.com/artk0de/TeaRAGs-MCP/commit/2e73825))

## 1.13.0 (2026-03-21)

- improve(explore): address 12 skill audit findings in search-cascade
  ([fc3f6a9](https://github.com/artk0de/TeaRAGs-MCP/commit/fc3f6a9))
- improve(explore): complete search-cascade audit fixes
  ([eeec0a3](https://github.com/artk0de/TeaRAGs-MCP/commit/eeec0a3))
- improve(mcp): unify index_codebase and reindex_changes output format
  ([63bdd06](https://github.com/artk0de/TeaRAGs-MCP/commit/63bdd06))
- fix(explore): preserve rankingOverlay in rank_chunks results
  ([284a496](https://github.com/artk0de/TeaRAGs-MCP/commit/284a496))
- fix(ingest): scope enrichment to changed files and skip for deletion-only
  reindex ([6b5da2d](https://github.com/artk0de/TeaRAGs-MCP/commit/6b5da2d))
- feat(chunker): add RSpec-aware chunking for Ruby spec files
  ([6e7389c](https://github.com/artk0de/TeaRAGs-MCP/commit/6e7389c))

## <small>1.12.3 (2026-03-21)</small>

- improve(ingest): update lastUpdated on no-change incremental reindex
  ([4b46a3f](https://github.com/artk0de/TeaRAGs-MCP/commit/4b46a3f))
- fix(ingest): update completedAt marker on incremental reindex
  ([1c27125](https://github.com/artk0de/TeaRAGs-MCP/commit/1c27125))

## <small>1.12.2 (2026-03-21)</small>

- fix(website): escape MDX placeholders and fix broken links in troubleshooting
  page ([7666b6b](https://github.com/artk0de/TeaRAGs-MCP/commit/7666b6b))

## <small>1.12.1 (2026-03-21)</small>

- fix(dx): move marketplace.json to repo root for plugin discovery
  ([28f0b04](https://github.com/artk0de/TeaRAGs-MCP/commit/28f0b04))

## 1.12.0 (2026-03-21)

- fix(adapters): pass original error as cause instead of wrapping in new Error
  ([b3b1855](https://github.com/artk0de/TeaRAGs-MCP/commit/b3b1855))
- fix(all): replace every remaining plain Error with typed errors
  ([35d2e41](https://github.com/artk0de/TeaRAGs-MCP/commit/35d2e41))
- fix(bootstrap): update default Ollama model to
  unclemusclez/jina-embeddings-v2-base-code
  ([e15e209](https://github.com/artk0de/TeaRAGs-MCP/commit/e15e209))
- fix(config): add OLLAMA_URL as fallback for EMBEDDING_BASE_URL
  ([3421332](https://github.com/artk0de/TeaRAGs-MCP/commit/3421332))
- fix(infra): add defensive assertion in resolveCollection, fix no-op test
  ([41c5095](https://github.com/artk0de/TeaRAGs-MCP/commit/41c5095))
- fix(ingest): add embedding health check before indexing and status queries
  ([2d559a3](https://github.com/artk0de/TeaRAGs-MCP/commit/2d559a3))
- fix(ingest): propagate TeaRagsError from indexCodebase instead of swallowing
  ([0245241](https://github.com/artk0de/TeaRAGs-MCP/commit/0245241))
- fix(pipeline): propagate batch errors instead of silently swallowing them
  ([ad376cf](https://github.com/artk0de/TeaRAGs-MCP/commit/ad376cf))
- test(ingest): add TDD tests for OllamaUnavailableError propagation
  ([681e41b](https://github.com/artk0de/TeaRAGs-MCP/commit/681e41b))
- improve(bootstrap): graceful startup — remove pre-flight Ollama check
  ([d17ca83](https://github.com/artk0de/TeaRAGs-MCP/commit/d17ca83))
- improve(dx): merge reindex-changes into index skill
  ([5b3bbc1](https://github.com/artk0de/TeaRAGs-MCP/commit/5b3bbc1))
- improve(mcp): deprecate reindex_changes — index_codebase handles both
  ([d49ad79](https://github.com/artk0de/TeaRAGs-MCP/commit/d49ad79))
- improve(plugin): delegate tool selection to search-cascade, add
  refactoring-scan skill
  ([5cc8cee](https://github.com/artk0de/TeaRAGs-MCP/commit/5cc8cee))
- improve(plugin): enforce search-cascade as critical tool selection rule
  ([ec84096](https://github.com/artk0de/TeaRAGs-MCP/commit/ec84096))
- improve(plugin): expand LSP profile with call chain, implementations,
  performance warning
  ([0290e74](https://github.com/artk0de/TeaRAGs-MCP/commit/0290e74))
- improve(plugin): expand pattern-search intent triggers in explore skill
  ([4e10504](https://github.com/artk0de/TeaRAGs-MCP/commit/4e10504))
- improve(plugin): integrate pattern-search as internal explore strategy
  ([7917a0b](https://github.com/artk0de/TeaRAGs-MCP/commit/7917a0b))
- improve(plugin): integrate search-cascade into pattern-search SEED step
  ([f0362d9](https://github.com/artk0de/TeaRAGs-MCP/commit/f0362d9))
- improve(plugin): remove LSP references — causes hangs, use ripgrep/tree-sitter
  ([01ffd96](https://github.com/artk0de/TeaRAGs-MCP/commit/01ffd96))
- improve(plugin): rewrite search-cascade with combo strategy and profiles
  ([0d2dcad](https://github.com/artk0de/TeaRAGs-MCP/commit/0d2dcad))
- refactor(adapters): extract shared retry utility and deduplicate config/schema
  builders ([b507faf](https://github.com/artk0de/TeaRAGs-MCP/commit/b507faf))
- refactor(all): extract logic from barrel index.ts files
  ([b67ffb4](https://github.com/artk0de/TeaRAGs-MCP/commit/b67ffb4))
- refactor(ingest): extract helpers and remove unused for+break duplicates
  ([aaa2211](https://github.com/artk0de/TeaRAGs-MCP/commit/aaa2211))
- feat(adapters): add InfraError hierarchy with adapter-specific errors
  ([e0924fe](https://github.com/artk0de/TeaRAGs-MCP/commit/e0924fe))
- feat(cli): add CLI entrypoint and update bin to cli/index.js
  ([0d55a84](https://github.com/artk0de/TeaRAGs-MCP/commit/0d55a84))
- feat(cli): add YAML config loader with project/global merge
  ([7f65da5](https://github.com/artk0de/TeaRAGs-MCP/commit/7f65da5))
- feat(cli): add yargs entrypoint with server command stub
  ([81cfbb6](https://github.com/artk0de/TeaRAGs-MCP/commit/81cfbb6))
- feat(cli): implement tea-rags server command
  ([f86f762](https://github.com/artk0de/TeaRAGs-MCP/commit/f86f762))
- feat(contracts): add TeaRagsError hierarchy, InputValidationError, migrate
  CollectionRefError
  ([e915bd7](https://github.com/artk0de/TeaRAGs-MCP/commit/e915bd7))
- feat(dx): add background indexing skills and update search-cascade
  ([4847cf7](https://github.com/artk0de/TeaRAGs-MCP/commit/4847cf7))
- feat(ingest): track ignore pattern changes in reindex + decompose pipelines
  ([2ee3843](https://github.com/artk0de/TeaRAGs-MCP/commit/2ee3843))
- feat(ingest): zero-downtime forceReindex via Qdrant collection aliases
  ([414781c](https://github.com/artk0de/TeaRAGs-MCP/commit/414781c))
- feat(mcp): add errorHandlerMiddleware, migrate all tools to registerToolSafe
  ([e5be47f](https://github.com/artk0de/TeaRAGs-MCP/commit/e5be47f))
- feat(plugin): add pattern-search skill for cross-codebase pattern discovery
  ([4ac2ed0](https://github.com/artk0de/TeaRAGs-MCP/commit/4ac2ed0))
- feat(qdrant): add static payload indexes for language, fileExtension,
  chunkType ([24266d4](https://github.com/artk0de/TeaRAGs-MCP/commit/24266d4))
- docs(cli): add CLI executable design spec
  ([86811d2](https://github.com/artk0de/TeaRAGs-MCP/commit/86811d2))
- docs(dx): add typed-errors rule for mandatory error hierarchy usage
  ([e646922](https://github.com/artk0de/TeaRAGs-MCP/commit/e646922))
- docs(dx): update search-cascade for typed error handling
  ([9dc91bc](https://github.com/artk0de/TeaRAGs-MCP/commit/9dc91bc))
- docs(operations): add AliasOperationError and zero-downtime reindex FAQ
  ([31ccecc](https://github.com/artk0de/TeaRAGs-MCP/commit/31ccecc))
- docs(operations): add error codes reference, rename troubleshooting page
  ([51b41e3](https://github.com/artk0de/TeaRAGs-MCP/commit/51b41e3))
- docs(plans): add collection aliases implementation plan
  ([41143cf](https://github.com/artk0de/TeaRAGs-MCP/commit/41143cf))
- docs(plans): add error handling implementation plan
  ([6c7ca33](https://github.com/artk0de/TeaRAGs-MCP/commit/6c7ca33))
- docs(plans): add streaming chunk enrichment plan
  ([e86701c](https://github.com/artk0de/TeaRAGs-MCP/commit/e86701c))
- docs(specs): add collection aliases and project registry design specs
  ([bbecbe9](https://github.com/artk0de/TeaRAGs-MCP/commit/bbecbe9))
- docs(specs): add unified error handling design spec
  ([3ed02fd](https://github.com/artk0de/TeaRAGs-MCP/commit/3ed02fd))
- docs(specs): fix error handling spec after review
  ([f10c8fc](https://github.com/artk0de/TeaRAGs-MCP/commit/f10c8fc))
- docs(specs): fix review issues, add typed-errors rule, complete migration
  ([1425c23](https://github.com/artk0de/TeaRAGs-MCP/commit/1425c23))
- docs(specs): update error handling spec with brainstorming decisions
  ([926982f](https://github.com/artk0de/TeaRAGs-MCP/commit/926982f))
- docs(usage): add Ignoring Files page with dynamic ignore tracking
  ([5a16536](https://github.com/artk0de/TeaRAGs-MCP/commit/5a16536))
- chore(deps): add yargs and yaml for CLI
  ([2daa77e](https://github.com/artk0de/TeaRAGs-MCP/commit/2daa77e))
- chore(plugin): bump version to 0.3.1 for new indexing skills
  ([5534a4c](https://github.com/artk0de/TeaRAGs-MCP/commit/5534a4c))
- feat(adapters,domains): migrate all throw sites to typed errors
  ([5c500df](https://github.com/artk0de/TeaRAGs-MCP/commit/5c500df))
- fix(adapters,domains): replace all remaining plain Error throws with typed
  errors ([0b5fe9c](https://github.com/artk0de/TeaRAGs-MCP/commit/0b5fe9c))
- style(rerank,schemas): apply eslint auto-fixes
  ([9e2ae4d](https://github.com/artk0de/TeaRAGs-MCP/commit/9e2ae4d))

## 1.11.0 (2026-03-17)

- test(explore): add offset pagination tests for BaseExploreStrategy
  ([e9846da](https://github.com/artk0de/TeaRAGs-MCP/commit/e9846da))
- fix(dx): deny commit instead of ask when plugin version not bumped
  ([448e611](https://github.com/artk0de/TeaRAGs-MCP/commit/448e611))
- feat(api): add offset parameter to semantic_search, hybrid_search, search_code
  ([95f6119](https://github.com/artk0de/TeaRAGs-MCP/commit/95f6119))
- feat(dx): add PreToolUse hook to check plugin version bump before commit
  ([84b0ace](https://github.com/artk0de/TeaRAGs-MCP/commit/84b0ace))
- refactor(plugin): move pagination to cascade rule — applies to all tools
  ([2c96c0e](https://github.com/artk0de/TeaRAGs-MCP/commit/2c96c0e))
- improve(plugin): remove hard limits from research — agent decides iteration
  ([e3ecc40](https://github.com/artk0de/TeaRAGs-MCP/commit/e3ecc40))
- improve(plugin): remove symbol verification from research, add balanced rerank
  ([6e97f55](https://github.com/artk0de/TeaRAGs-MCP/commit/6e97f55))
- improve(plugin): research outputs facts not strategy, adds iteration budget
  ([3791215](https://github.com/artk0de/TeaRAGs-MCP/commit/3791215))
- improve(plugin): research skill flags problematic zones, uses filters
  ([81d307e](https://github.com/artk0de/TeaRAGs-MCP/commit/81d307e))

## 1.10.0 (2026-03-17)

- feat(plugin): add explore + research skills, refactor data-driven-generation
  ([467fa49](https://github.com/artk0de/TeaRAGs-MCP/commit/467fa49))
- chore(plugin): bump version to 0.1.1
  ([88ed825](https://github.com/artk0de/TeaRAGs-MCP/commit/88ed825))

## <small>1.9.1 (2026-03-17)</small>

- improve(plugin): make session start instructions imperative
  ([3bdbd17](https://github.com/artk0de/TeaRAGs-MCP/commit/3bdbd17))

## 1.9.0 (2026-03-17)

- fix(plugin): always reindex_changes on session start, not only on drift
  ([b9abfb6](https://github.com/artk0de/TeaRAGs-MCP/commit/b9abfb6))
- fix(plugin): prepare for marketplace install with working hooks
  ([80a4699](https://github.com/artk0de/TeaRAGs-MCP/commit/80a4699))
- fix(plugin): use script for hook instead of inline cat with env var
  ([5f14117](https://github.com/artk0de/TeaRAGs-MCP/commit/5f14117))
- improve(plugin): add session start check, presets/filters reference to cascade
  ([c18e422](https://github.com/artk0de/TeaRAGs-MCP/commit/c18e422))
- improve(plugin): add tool selection examples to search-cascade rule
  ([ea046f9](https://github.com/artk0de/TeaRAGs-MCP/commit/ea046f9))
- improve(plugin): LSP-first cascade, auto-detect tools on session start
  ([6c5c349](https://github.com/artk0de/TeaRAGs-MCP/commit/6c5c349))
- improve(plugin): memorize label thresholds after indexing
  ([066abf4](https://github.com/artk0de/TeaRAGs-MCP/commit/066abf4))
- improve(plugin): remove mandatory verify — trust the index
  ([014f606](https://github.com/artk0de/TeaRAGs-MCP/commit/014f606))
- feat(plugin): inject search-cascade rules via SessionStart hook
  ([37e2176](https://github.com/artk0de/TeaRAGs-MCP/commit/37e2176))

## 1.8.0 (2026-03-17)

- improve(plugin): drill-down + spread check in bug-hunt
  ([415ea7d](https://github.com/artk0de/TeaRAGs-MCP/commit/415ea7d))
- improve(plugin): enforce self-execution and label trust in bug-hunt
  ([10b10dc](https://github.com/artk0de/TeaRAGs-MCP/commit/10b10dc))
- improve(plugin): force ripgrep MCP in bug-hunt verify step
  ([ecbe63d](https://github.com/artk0de/TeaRAGs-MCP/commit/ecbe63d))
- improve(plugin): make ripgrep optional in bug-hunt — agent decides
  ([381cf73](https://github.com/artk0de/TeaRAGs-MCP/commit/381cf73))
- improve(plugin): multi-query discovery with intersection in bug-hunt
  ([f75e7b5](https://github.com/artk0de/TeaRAGs-MCP/commit/f75e7b5))
- improve(plugin): optimize bug-hunt to 4 steps with parallel tool calls
  ([4bfe45e](https://github.com/artk0de/TeaRAGs-MCP/commit/4bfe45e))
- improve(plugin): parallel tree-sitter + ripgrep in verify discover step
  ([7e70c92](https://github.com/artk0de/TeaRAGs-MCP/commit/7e70c92))
- improve(plugin): restructure bug-hunt skill as checkpoint loop + fix applier
  overwrite ([63eabd5](https://github.com/artk0de/TeaRAGs-MCP/commit/63eabd5))
- feat(filters): glob pre-filter via Qdrant full-text index on relativePath
  ([1f06e5b](https://github.com/artk0de/TeaRAGs-MCP/commit/1f06e5b))
- fix(plugin): consolidate bug-hunt skill — original structure + mandatory
  ripgrep ([b8c67ae](https://github.com/artk0de/TeaRAGs-MCP/commit/b8c67ae))
- fix(plugin): fix cascade rule — read files for understanding, ripgrep for
  confirming ([7ff01f6](https://github.com/artk0de/TeaRAGs-MCP/commit/7ff01f6))
- fix(plugin): limit=10 default, use offset for pagination
  ([c089f64](https://github.com/artk0de/TeaRAGs-MCP/commit/c089f64))
- fix(plugin): make ripgrep MCP mandatory in bug-hunt
  ([c9377b2](https://github.com/artk0de/TeaRAGs-MCP/commit/c9377b2))
- fix(plugin): no rerank on discover step — pure similarity for area finding
  ([4d6e274](https://github.com/artk0de/TeaRAGs-MCP/commit/4d6e274))
- fix(plugin): scope ripgrep to discovered area, not entire project
  ([aa902e9](https://github.com/artk0de/TeaRAGs-MCP/commit/aa902e9))
- fix(plugin): split discover + verify into separate steps in bug-hunt
  ([547b314](https://github.com/artk0de/TeaRAGs-MCP/commit/547b314))
- fix(presets): add rank_chunks to bugHunt preset tools list
  ([dd23c4b](https://github.com/artk0de/TeaRAGs-MCP/commit/dd23c4b))
- refactor(plugin): enforce strict tool discipline in bug-hunt skill
  ([62d7408](https://github.com/artk0de/TeaRAGs-MCP/commit/62d7408))
- refactor(plugin): remove redundant verify, prefer ripgrep over file reads
  ([d0d525c](https://github.com/artk0de/TeaRAGs-MCP/commit/d0d525c))
- refactor(plugin): rewrite bug-hunt skill per writing-skills best practices
  ([8b2c05c](https://github.com/artk0de/TeaRAGs-MCP/commit/8b2c05c))
- revert(plugin): restore per-step verify in bug-hunt skill
  ([14b8429](https://github.com/artk0de/TeaRAGs-MCP/commit/14b8429))

## <small>1.7.3 (2026-03-16)</small>

- improve(plugin): move validation to single verify step in bug-hunt
  ([366bcd4](https://github.com/artk0de/TeaRAGs-MCP/commit/366bcd4))

## <small>1.7.2 (2026-03-16)</small>

- improve(plugin): make bug-hunt verify step concrete
  ([94501b3](https://github.com/artk0de/TeaRAGs-MCP/commit/94501b3))

## <small>1.7.1 (2026-03-16)</small>

- improve(ingest): add .contextignore.local support and raise test coverage to
  96.9% ([f98323c](https://github.com/artk0de/TeaRAGs-MCP/commit/f98323c))
- improve(plugin): enforce strict tool parameters in bug-hunt skill
  ([51a843e](https://github.com/artk0de/TeaRAGs-MCP/commit/51a843e))
- fix(explore): overfetch in scroll-rank when pathPattern is set
  ([35164ce](https://github.com/artk0de/TeaRAGs-MCP/commit/35164ce))
- chore(plugin): add marketplace.json for local and remote installation
  ([434d02a](https://github.com/artk0de/TeaRAGs-MCP/commit/434d02a))

## 1.7.0 (2026-03-16)

- improve(plugin): add hybrid_search fallback to semantic_search
  ([2d076b2](https://github.com/artk0de/TeaRAGs-MCP/commit/2d076b2))
- feat(plugin): create tea-rags Claude Code plugin
  ([2d70a06](https://github.com/artk0de/TeaRAGs-MCP/commit/2d70a06))
- docs(plans): add data-driven generation plugin implementation plan
  ([9b96737](https://github.com/artk0de/TeaRAGs-MCP/commit/9b96737))
- docs(specs): add data-driven generation Claude plugin design spec
  ([1952a42](https://github.com/artk0de/TeaRAGs-MCP/commit/1952a42))

## 1.6.0 (2026-03-16)

- feat(mcp): add signal-labels schema resource, fix label declarations
  ([05d2a58](https://github.com/artk0de/TeaRAGs-MCP/commit/05d2a58))
- fix(ingest): use readPayloadPath for dominantAuthor in distributions
  ([057d32a](https://github.com/artk0de/TeaRAGs-MCP/commit/057d32a))
- fix(onnx): detect stale daemon socket and respawn automatically
  ([88321c7](https://github.com/artk0de/TeaRAGs-MCP/commit/88321c7))

## 1.5.0 (2026-03-16)

- feat(api): add getIndexMetrics to App interface and ExploreFacade
  ([6657cb2](https://github.com/artk0de/TeaRAGs-MCP/commit/6657cb2))
- feat(dto): add IndexMetrics DTO for get_index_metrics
  ([2d66e68](https://github.com/artk0de/TeaRAGs-MCP/commit/2d66e68))
- feat(infra): bump StatsCache to v3 with distributions support
  ([b0f5cab](https://github.com/artk0de/TeaRAGs-MCP/commit/b0f5cab))
- feat(ingest): compute distributions and min/max in computeCollectionStats
  ([f8ceb71](https://github.com/artk0de/TeaRAGs-MCP/commit/f8ceb71))
- feat(mcp): register get_index_metrics tool
  ([ec42101](https://github.com/artk0de/TeaRAGs-MCP/commit/ec42101))
- feat(presets): add bugHunt preset for finding potential bug locations
  ([65d13b3](https://github.com/artk0de/TeaRAGs-MCP/commit/65d13b3))
- feat(reranker): add label-resolver for overlay value labeling
  ([68daa7f](https://github.com/artk0de/TeaRAGs-MCP/commit/68daa7f))
- feat(reranker): integrate label resolution into buildOverlay()
  ([26c80e3](https://github.com/artk0de/TeaRAGs-MCP/commit/26c80e3))
- refactor(contracts): add min/max to SignalStats, add Distributions
  ([72d7863](https://github.com/artk0de/TeaRAGs-MCP/commit/72d7863))
- refactor(contracts): replace percentiles with labels in SignalStatsRequest
  ([6979647](https://github.com/artk0de/TeaRAGs-MCP/commit/6979647))
- refactor(reranker): remove derived from OverlayMask and RankingOverlay
  ([7f764b5](https://github.com/artk0de/TeaRAGs-MCP/commit/7f764b5))
- docs(plans): add index-metrics + overlay labels implementation plan
  ([780aae7](https://github.com/artk0de/TeaRAGs-MCP/commit/780aae7))
- docs(presets): add JSDoc to all 11 rerank presets
  ([9da1aaf](https://github.com/artk0de/TeaRAGs-MCP/commit/9da1aaf))
- docs(signals): add JSDoc to all 20 derived signals and enforce in rules
  ([85ec69e](https://github.com/artk0de/TeaRAGs-MCP/commit/85ec69e))
- docs(specs): add get_index_metrics + overlay labels design spec
  ([d608e82](https://github.com/artk0de/TeaRAGs-MCP/commit/d608e82))

## 1.4.0 (2026-03-15)

- feat(config): add QDRANT_QUANTIZATION_SCALAR env flag
  ([a767bc8](https://github.com/artk0de/TeaRAGs-MCP/commit/a767bc8))
- feat(ingest): pass quantizationScalar to collection creation in IndexPipeline
  ([5efd311](https://github.com/artk0de/TeaRAGs-MCP/commit/5efd311))
- feat(qdrant): add scalar quantization support to createCollection
  ([d83b9f2](https://github.com/artk0de/TeaRAGs-MCP/commit/d83b9f2))
- feat(qdrant): wire quantizationScalar through CollectionOps and AppDeps
  ([679c219](https://github.com/artk0de/TeaRAGs-MCP/commit/679c219))
- refactor(infra): move signal-utils from contracts/ to infra/
  ([5fae09c](https://github.com/artk0de/TeaRAGs-MCP/commit/5fae09c))
- docs(plans): add scalar quantization implementation plan
  ([d76ca6f](https://github.com/artk0de/TeaRAGs-MCP/commit/d76ca6f))
- docs(specs): add scalar quantization design spec
  ([1587b5b](https://github.com/artk0de/TeaRAGs-MCP/commit/1587b5b))
- style(mcp): fix no-useless-concat in schema descriptions
  ([cb6b5a1](https://github.com/artk0de/TeaRAGs-MCP/commit/cb6b5a1))

## 1.3.0 (2026-03-15)

- fix(api): fix schema inconsistencies and incorrect resource examples
  ([b96bd97](https://github.com/artk0de/TeaRAGs-MCP/commit/b96bd97))
- improve(api): compact search_code and index_codebase descriptions
  ([10bfe54](https://github.com/artk0de/TeaRAGs-MCP/commit/10bfe54))
- improve(api): compact semantic_search and hybrid_search descriptions
  ([abaef5d](https://github.com/artk0de/TeaRAGs-MCP/commit/abaef5d))
- improve(api): consolidate filter parameters in MCP schemas
  ([908047a](https://github.com/artk0de/TeaRAGs-MCP/commit/908047a))
- improve(api): trim 'Use for' from typed filter descriptions
  ([e9e7846](https://github.com/artk0de/TeaRAGs-MCP/commit/e9e7846))
- improve(mcp): add schema overview link to search tool descriptions
  ([1581205](https://github.com/artk0de/TeaRAGs-MCP/commit/1581205))
- improve(mcp): add ToolAnnotations to all tools
  ([1714577](https://github.com/artk0de/TeaRAGs-MCP/commit/1714577))
- improve(mcp): compact SchemaBuilder — remove per-value descriptions from tool
  schema ([fc43880](https://github.com/artk0de/TeaRAGs-MCP/commit/fc43880))
- improve(presets): add per-preset descriptions to MCP schema
  ([076a93f](https://github.com/artk0de/TeaRAGs-MCP/commit/076a93f))
- test(api): tighten path assertion in indexing guide test
  ([703452a](https://github.com/artk0de/TeaRAGs-MCP/commit/703452a))
- test(signals): add signal level tests for types, helpers, and blending
  ([689cfaa](https://github.com/artk0de/TeaRAGs-MCP/commit/689cfaa))
- feat(api): add search-guide and indexing-guide resource builders
  ([fbb9597](https://github.com/artk0de/TeaRAGs-MCP/commit/fbb9597))
- feat(api): extend PresetDescriptors with preset details for resource docs
  ([af11e04](https://github.com/artk0de/TeaRAGs-MCP/commit/af11e04))
- feat(api): register search-guide and indexing-guide resources, add Guides to
  overview ([b2dfa26](https://github.com/artk0de/TeaRAGs-MCP/commit/b2dfa26))
- feat(mcp): add schema documentation MCP Resource
  ([3f99285](https://github.com/artk0de/TeaRAGs-MCP/commit/3f99285))
- feat(mcp): add shared outputSchema for search tools
  ([c436059](https://github.com/artk0de/TeaRAGs-MCP/commit/c436059))
- feat(mcp): split schema documentation into 4 focused MCP resources
  ([2ff993e](https://github.com/artk0de/TeaRAGs-MCP/commit/2ff993e))
- docs(api): add schema compaction wave 2 design spec
  ([b138140](https://github.com/artk0de/TeaRAGs-MCP/commit/b138140))
- docs(api): add schema compaction wave 2 implementation plan
  ([49d367f](https://github.com/artk0de/TeaRAGs-MCP/commit/49d367f))
- docs(mcp): add per-resource schema docs implementation plan
  ([07c09f5](https://github.com/artk0de/TeaRAGs-MCP/commit/07c09f5))
- docs(mcp): add per-resource schema documentation design spec
  ([16ae541](https://github.com/artk0de/TeaRAGs-MCP/commit/16ae541))
- docs(mcp): improve tool and parameter descriptions
  ([6796bf6](https://github.com/artk0de/TeaRAGs-MCP/commit/6796bf6))

## <small>1.2.1 (2026-03-15)</small>

- docs(api): add level parameter and signalLevel docs to tools.md
  ([22ac932](https://github.com/artk0de/TeaRAGs-MCP/commit/22ac932))

## 1.2.0 (2026-03-15)

- feat(rerank): add signalLevel system for preset scoring granularity
  ([2d5d83c](https://github.com/artk0de/TeaRAGs-MCP/commit/2d5d83c))
- docs(plans): signal level implementation plan — 11 tasks
  ([50a2465](https://github.com/artk0de/TeaRAGs-MCP/commit/50a2465))
- docs(specs): replace SignalLevel "auto" with "chunk" — explicit is better
  ([a7df600](https://github.com/artk0de/TeaRAGs-MCP/commit/a7df600))
- docs(specs): signal level & consistent level parameter design
  ([394ebc6](https://github.com/artk0de/TeaRAGs-MCP/commit/394ebc6))

## <small>1.1.1 (2026-03-15)</small>

- improve(presets): add chunk-level signals to securityAudit, techDebt,
  ownership presets
  ([2883199](https://github.com/artk0de/TeaRAGs-MCP/commit/2883199))

## 1.1.0 (2026-03-14)

- chore(dx): add .claude/worktrees to gitignore
  ([438e09b](https://github.com/artk0de/TeaRAGs-MCP/commit/438e09b))
- docs(api): add find_similar tool documentation
  ([43fa7e2](https://github.com/artk0de/TeaRAGs-MCP/commit/43fa7e2))
- docs(explore): add find_similar spec, plan, update add-mcp-endpoint skill
  ([15877f5](https://github.com/artk0de/TeaRAGs-MCP/commit/15877f5))
- feat(api): add FindSimilarRequest DTO for find_similar tool
  ([2a07f30](https://github.com/artk0de/TeaRAGs-MCP/commit/2a07f30))
- feat(explore): add ExploreFacade.findSimilar() and App wiring
  ([77f78ca](https://github.com/artk0de/TeaRAGs-MCP/commit/77f78ca))
- feat(explore): add QdrantManager.query() for recommend API
  ([9626a15](https://github.com/artk0de/TeaRAGs-MCP/commit/9626a15))
- feat(explore): add SimilarSearchStrategy for find_similar tool
  ([b2c7cd1](https://github.com/artk0de/TeaRAGs-MCP/commit/b2c7cd1))
- feat(mcp): register find_similar tool with Zod schema
  ([9f6faa3](https://github.com/artk0de/TeaRAGs-MCP/commit/9f6faa3))
- feat(presets): add find_similar to preset tools[] arrays
  ([e9d64ba](https://github.com/artk0de/TeaRAGs-MCP/commit/e9d64ba))

## <small>1.0.4 (2026-03-14)</small>

- ([5c4ff7c](https://github.com/artk0de/TeaRAGs-MCP/commit/5c4ff7c))
- fix(ci): escape angle brackets in changelog for MDX compatibility
  ([ba48aae](https://github.com/artk0de/TeaRAGs-MCP/commit/ba48aae))
- docs(dx): add parallel-sessions rule and .claudeignore
  ([3640992](https://github.com/artk0de/TeaRAGs-MCP/commit/3640992))

## <small>1.0.3 (2026-03-14)</small>

- ([c70b1a2](https://github.com/artk0de/TeaRAGs-MCP/commit/c70b1a2))
- fix(ci): use markdown format: detect to fix changelog MDX parse errors
  ([db47186](https://github.com/artk0de/TeaRAGs-MCP/commit/db47186))

## <small>1.0.2 (2026-03-14)</small>

- fix(ci): deploy docs on every push, not just release commits
  ([94630db](https://github.com/artk0de/TeaRAGs-MCP/commit/94630db))
- fix(ci): deploy docs only on chore(release) commits
  ([dbb7b89](https://github.com/artk0de/TeaRAGs-MCP/commit/dbb7b89))
- ([682622b](https://github.com/artk0de/TeaRAGs-MCP/commit/682622b))

## <small>1.0.1 (2026-03-13)</small>

- ci(docs): make deploy-docs a self-contained job with own checkout
  ([7424f9c](https://github.com/artk0de/TeaRAGs-MCP/commit/7424f9c))
- docs(dx): add path shortcuts, deep navigation rule, and add-language-hook
  skill ([1ff2a0b](https://github.com/artk0de/TeaRAGs-MCP/commit/1ff2a0b))
- docs(dx): add skills for signals/presets and rules for wiring/testing
  ([25845cf](https://github.com/artk0de/TeaRAGs-MCP/commit/25845cf))
- refactor(dx): add domain barrel files and barrel-files rule
  ([b869152](https://github.com/artk0de/TeaRAGs-MCP/commit/b869152))

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
- refactor(explore): rename RawResult → ExploreResult&lt;P&gt;, executeSearch →
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

Co-Authored-By: Claude Opus 4.6 &lt;noreply@anthropic.com&gt;

- QDRANT_URL default changed from http://localhost:6333 to autodetect. Set
  QDRANT_URL explicitly if using external Qdrant.

Co-Authored-By: Claude Opus 4.6 &lt;noreply@anthropic.com&gt;

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
