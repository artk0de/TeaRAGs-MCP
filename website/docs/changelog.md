---
title: Changelog
sidebar_position: 99
---

## [1.30.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.29.0...v1.30.0) (2026-06-06)

### Features

* **adapters:** proxy getCalleeEdges through codegraph daemon ([0977346](https://github.com/artk0de/TeaRAGs-MCP/commit/09773460fdc8dee74468c52890d020c3a4301663))
* **api:** config-driven curated rerank preset enum for trace_path ([5c962af](https://github.com/artk0de/TeaRAGs-MCP/commit/5c962af9a33846aa3241c9264db3b0b3130aa7f8))
* **api:** trace_path DTOs (TracePathRequest, PathStep, TracedPath, PathTraceResult) ([022cb50](https://github.com/artk0de/TeaRAGs-MCP/commit/022cb50fd8f34aa32f80d63cffe097fcf2017261))
* **api:** TracePathOps — bounded frontier BFS + path enumeration + danger overlay ([859734c](https://github.com/artk0de/TeaRAGs-MCP/commit/859734cb2a44e094ae643dae60fdc6042b433022))
* **api:** wire App.tracePath -&gt; TracePathOps with codegraph-disabled fallback ([cb74047](https://github.com/artk0de/TeaRAGs-MCP/commit/cb740476f9d7471b683cd938a86e4dbccd63ff74))
* **cli:** colored informative table for tea-rags projects ([0a16095](https://github.com/artk0de/TeaRAGs-MCP/commit/0a16095d14b52d66783622343ba3132c876fcd99))
* **mcp:** add pathPattern scope filter to find_cycles ([266cd3c](https://github.com/artk0de/TeaRAGs-MCP/commit/266cd3c6a7c535f837184dd495c4599321ccb5b6))
* **mcp:** register trace_path tool (gated by codegraph.symbols) ([8ac8a1c](https://github.com/artk0de/TeaRAGs-MCP/commit/8ac8a1c928d7f95b509790dde51dbcc9f437b8fe))
* **qdrant:** scrollBySymbolIds batch payload hydration for trace_path ([12b008c](https://github.com/artk0de/TeaRAGs-MCP/commit/12b008c92643faf8667deccdf89aabf8ae4853bb))
* **rerank:** add annotate-only mode (reorder:false) preserving input order ([7a7db0d](https://github.com/artk0de/TeaRAGs-MCP/commit/7a7db0dd363bb7d0f394e3a801e761a29144c686))
* **signals:** add TSSameFileSymbolResolutionStrategy (same-file resolution pass) ([2c6dcd9](https://github.com/artk0de/TeaRAGs-MCP/commit/2c6dcd977a9ca71bbe2fa10d7fbaa07ffbffbf25))
* **signals:** wire sameFile strategy into TS resolver chain at position 8 ([57396a3](https://github.com/artk0de/TeaRAGs-MCP/commit/57396a3eba1d203e487dae5bf438f167b10c55b5))
* **skills:** add 4 codegraph sub-patterns to tea-rags:explore ([771ecb8](https://github.com/artk0de/TeaRAGs-MCP/commit/771ecb8b48dd8f459409d6432194b08f23b24448))
* **skills:** add project auto-registration step to setup wizard ([d5e71d3](https://github.com/artk0de/TeaRAGs-MCP/commit/d5e71d3dd91776108ff18129953ccf20a8a3d674))
* **trajectory:** build Ruby file-level edges from zeitwerk constants + inheritance ([82a375b](https://github.com/artk0de/TeaRAGs-MCP/commit/82a375b7c05d07a8cda32b574119fee997dd62bb))
* **trajectory:** emit Ruby chunk-edges for registry constant-literal values ([6fc24de](https://github.com/artk0de/TeaRAGs-MCP/commit/6fc24de3fe3755e6d9c8f884037e333cfe968037))
* **trajectory:** GraphDbClient.getCalleeEdges batch adjacency for trace_path ([b3a17f7](https://github.com/artk0de/TeaRAGs-MCP/commit/b3a17f77b0c9c606a2f1b10e657ef43ba38fc46f))
* **trajectory:** link Ruby `delegate ... to:` methods to delegation target ([1f786ec](https://github.com/artk0de/TeaRAGs-MCP/commit/1f786eca9c30f3f379c2ea154c36c459c032cfde)), closes [#a](https://github.com/artk0de/TeaRAGs-MCP/issues/a) [#b](https://github.com/artk0de/TeaRAGs-MCP/issues/b) [Values#kind](https://github.com/artk0de/Values/issues/kind)
* **trajectory:** pure bounded-DFS path enumerator for trace_path ([063c679](https://github.com/artk0de/TeaRAGs-MCP/commit/063c679eb015939db892ed75e19e03cb29f001db))

### Bug Fixes

* **api:** pass exact limit to trace_path step hydration; doc tidy ([fd63ee7](https://github.com/artk0de/TeaRAGs-MCP/commit/fd63ee7a90130db3cf727e96f71c5ef805d8e0cc))
* **prime:** default prime path to cwd when no path/project given ([d35f137](https://github.com/artk0de/TeaRAGs-MCP/commit/d35f137faa27a1872f948ea960fef3966a1fa6b7))

### Documentation

* **codegraph:** design Ruby file-level edges (zeitwerk + inheritance) ([af0aa32](https://github.com/artk0de/TeaRAGs-MCP/commit/af0aa325e94d8ebbe58bc815b7a411b668de6295))
* **codegraph:** design TS same-file resolution pass ([1ff92ff](https://github.com/artk0de/TeaRAGs-MCP/commit/1ff92fffa91220d242f8a0681ce31814a780a75a))
* **codegraph:** implementation plan for TS same-file resolution pass ([34e2472](https://github.com/artk0de/TeaRAGs-MCP/commit/34e24727ef1a5fdb7a31ed62f7e3f2dd06121b3d))
* **codegraph:** TS resolver open questions / further-investigation backlog ([12f1ad5](https://github.com/artk0de/TeaRAGs-MCP/commit/12f1ad5cd5cbeb8a9b1ee6341ca75f06579812a4))
* **mcp:** list trace_path in codegraph header; document maxDepth cap rationale ([f7204a8](https://github.com/artk0de/TeaRAGs-MCP/commit/f7204a8bc2bbb44f24369654df2ef9f52600e38e))
* **plan:** trace_path implementation plan (10 TDD tasks) ([9cecb72](https://github.com/artk0de/TeaRAGs-MCP/commit/9cecb72f0b20dc23736c140a8060314268ef3f27))
* **rerank:** note groupBy interaction under reorder:false ([1086cce](https://github.com/artk0de/TeaRAGs-MCP/commit/1086cce9d9b68229309ca685e3653d4fc436a505))
* **spec:** design colored informative table for tea-rags projects ([e62eb3c](https://github.com/artk0de/TeaRAGs-MCP/commit/e62eb3c014e3e2a9e848f1b8e096bd87e7c0cd29))
* surface trace_path in codegraph docs and plugin skills ([e677b40](https://github.com/artk0de/TeaRAGs-MCP/commit/e677b40bf0b71925c06dadda8f9615ffb91c456e))
* **trajectory:** clarify getCalleeEdges null-target wording (unresolved callee, not file edge) ([a5ce55c](https://github.com/artk0de/TeaRAGs-MCP/commit/a5ce55cad0b401b2e751f99233a7087881beb26d))
* **trajectory:** document Ruby codegraph static-analysis limitations ([c5d58e4](https://github.com/artk0de/TeaRAGs-MCP/commit/c5d58e481deab0dd105f521884f0d7476e591fdc))
* **website:** methodology for code-graph edge resolution across languages ([87efab3](https://github.com/artk0de/TeaRAGs-MCP/commit/87efab3ca657e73aedc131b61d49b89f6649b7b2))

### Code Refactoring

* **bootstrap:** hoist resolveActiveCollection closure; clarify codegraph block comment ([20d9f62](https://github.com/artk0de/TeaRAGs-MCP/commit/20d9f6237e2d098ca5661c1fdc6f1f64bade6311))
* **signals:** clarify sameFile scope filter, name class-receiver regex, document bare-call ambiguity ([2c90b64](https://github.com/artk0de/TeaRAGs-MCP/commit/2c90b6411177497fe955ef3cdaf502a69ac4b2dd))
* **trajectory:** domain-qualify path-tracer types, fully-readonly adjacency ([a8dd6b5](https://github.com/artk0de/TeaRAGs-MCP/commit/a8dd6b5434dd5bf8cc4b283cabf29ed818052194))

## [1.29.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.28.0...v1.29.0) (2026-06-05)

### ⚠ BREAKING CHANGES

- **merge:** CODEGRAPH_ENABLED now defaults to false; set it to true and
  re-index to keep codegraph signals and graph-query tools.
- **config:** CODEGRAPH_ENABLED now defaults to false. Users relying on
  codegraph signals or the get_callers/get_callees/find_cycles tools must set
  CODEGRAPH_ENABLED=true and re-index.

Co-Authored-By: Claude Opus 4.8 (1M context) &lt;noreply@anthropic.com&gt;

### Features

- **adapters:** add READ_ONLY access mode to DuckDbGraphClient
  ([be57cba](https://github.com/artk0de/TeaRAGs-MCP/commit/be57cba003df332c323f3c1fbd269f85ee8f87ed))
- **adapters:** codegraph daemon lifecycle (paths, file refcount, idle watcher)
  ([7d15dda](https://github.com/artk0de/TeaRAGs-MCP/commit/7d15ddae923bc5b9e6c9ff7720bd9d7692e1e90a))
- **adapters:** codegraph daemon wire protocol + newline-JSON framing
  ([877c175](https://github.com/artk0de/TeaRAGs-MCP/commit/877c1759ab4862f48d4b03568e33a54820a45ada))
- **adapters:** CodegraphDaemonServer request dispatch + daemon-side graph
  analysis
  ([e2804e3](https://github.com/artk0de/TeaRAGs-MCP/commit/e2804e3de227952e3a37549f6d1d50a4d6df5228))
- **adapters:** DaemonGraphDbClient socket proxy (write subset)
  ([fb07c3e](https://github.com/artk0de/TeaRAGs-MCP/commit/fb07c3eda9fa35046493a3f5e729a4f0fd14faa8))
- **adapters:** GraphDbClientPool mode-aware acquireRead/acquireWrite
  ([4f5d81f](https://github.com/artk0de/TeaRAGs-MCP/commit/4f5d81f66998139eeea9a251f8636ae828a1b366))
- **api:** widen api/public into the single consumer facade (tea-rags-mcp-lt42)
  ([77d79ab](https://github.com/artk0de/TeaRAGs-MCP/commit/77d79abfd7d57af672b7c14b103fcd0c1909a265))
- **chunker:** class-body-chunker derives groups from the dsl catalogue
  ([1912126](https://github.com/artk0de/TeaRAGs-MCP/commit/1912126c554b67b7d118cc503f745a9a440e962a))
- **chunker:** emit static symbols for macros inside class &lt;&lt; self
  (singleton_class)
  ([2d0189a](https://github.com/artk0de/TeaRAGs-MCP/commit/2d0189a67a57e170b47d0abd874ccafa92b7e81c))
- **chunker:** GoChunkClassifier (chunkType refine + Receiver#Method via
  goSymbolOf)
  ([58cfadc](https://github.com/artk0de/TeaRAGs-MCP/commit/58cfadc9aa2261e8cf8c3eace24291a2c083e5f1)),
  closes [Receiver#Method](https://github.com/artk0de/Receiver/issues/Method)
- **chunker:** JsChunkClassifier adapter over jsChunkSymbols
  ([53441d4](https://github.com/artk0de/TeaRAGs-MCP/commit/53441d499a51375c9706fbd30115a2d28d662308))
- **chunker:** ruby/dsl catalogue — single class-body declaration vocabulary
  ([2a938a8](https://github.com/artk0de/TeaRAGs-MCP/commit/2a938a8399789c16ad1a03a858932bc78d0f8984))
- **codegraph:** accept project/collection params in
  get_callers/get_callees/find_cycles
  ([fcb0261](https://github.com/artk0de/TeaRAGs-MCP/commit/fcb026178276b3bc1b176c03013f9065a30d5d80))
- **codegraph:** add stats.labels + connectionCount + instability confidence
  ([dbdec9e](https://github.com/artk0de/TeaRAGs-MCP/commit/dbdec9ef6c15a409707070f42533bf3445622cf0)),
  closes
  [IndexMetricsQuery#buildSignalMetrics](https://github.com/artk0de/IndexMetricsQuery/issues/buildSignalMetrics)
  [Reranker#applyLabelResolution](https://github.com/artk0de/Reranker/issues/applyLabelResolution)
- **codegraph:** expose codegraph payload signals via typed filter params
  ([973620c](https://github.com/artk0de/TeaRAGs-MCP/commit/973620c5c69eb8162c558911d5b486ba5cfebee7))
- **codegraph:** finalizeReindex deletes superseded version DB after alias swap
  ([b9bc374](https://github.com/artk0de/TeaRAGs-MCP/commit/b9bc3743a947ab96b70622846433d42a181c4233))
- **codegraph:** make daemon the default write path (remove opt-in flag) +
  connect readiness
  ([d709727](https://github.com/artk0de/TeaRAGs-MCP/commit/d709727e120f5558d4ac2c55190fc924ec5d68cd))
- **codegraph:** merge chunk-level signal wiring end-to-end + chunk-preset
  design
  ([169211c](https://github.com/artk0de/TeaRAGs-MCP/commit/169211c288deb4721d6f9c5bd01781c183a07c88))
- **codegraph:** merge receiver-type tracking follow-ups + dispatch design
  ([b6d956a](https://github.com/artk0de/TeaRAGs-MCP/commit/b6d956ac287458ea5ba681126cbd34163a5193dc))
- **codegraph:** resolve multi-target dispatch through lookup tables
  ([d60573b](https://github.com/artk0de/TeaRAGs-MCP/commit/d60573b21ee20ee79ec2a281d640f86a637e7866))
- **codegraph:** resolve Python inherited methods via base-class walk
  ([df2e19b](https://github.com/artk0de/TeaRAGs-MCP/commit/df2e19b35e61c5f1c45618d7d0928ea934288963))
- **codegraph:** resolve Python self.field cross-method calls
  ([959725e](https://github.com/artk0de/TeaRAGs-MCP/commit/959725e704b0eee35521fa05780104ef41c2eb89)),
  closes
  [SomeService#process](https://github.com/artk0de/SomeService/issues/process)
  [#member](https://github.com/artk0de/TeaRAGs-MCP/issues/member)
- **codegraph:** route writes through daemon + drop version-suffix strip
  ([9b4a81b](https://github.com/artk0de/TeaRAGs-MCP/commit/9b4a81b5682e2c8b74e518a0f16ff7721d38a6c2))
- **codegraph:** wire codegraph daemon into bootstrap (pool socket +
  spawn-on-demand)
  ([4a97b24](https://github.com/artk0de/TeaRAGs-MCP/commit/4a97b249732b24a157fcfe71bb198d80e3408412))
- **codegraph:** wire codegraph trajectory into
  validation/overlay/dampening/metrics/projection
  ([3427f9e](https://github.com/artk0de/TeaRAGs-MCP/commit/3427f9e2ac547e521b7c647c2e0796c0d1db2843))
- **config:** enforce full dependency-direction matrix in eslint guard
  (tea-rags-mcp-qbod)
  ([3ca1f7f](https://github.com/artk0de/TeaRAGs-MCP/commit/3ca1f7fe22b1a1475881b05f9fd940643e7d6a8e))
- **config:** make codegraph enrichment opt-in (beta), default off
  ([d654c3f](https://github.com/artk0de/TeaRAGs-MCP/commit/d654c3fcc9a4f6d819f22d811319e5d3f89d975e))
- **contracts:** add FileClassification + EnrichmentScope + shouldEnrich
  ([012a686](https://github.com/artk0de/TeaRAGs-MCP/commit/012a686264da6bc189d1b8b20bf9bd31dcdf7a2f))
- **contracts:** add LanguageChunkClassifier capability + ChunkDecision
  ([6503d32](https://github.com/artk0de/TeaRAGs-MCP/commit/6503d32bb5608c619a1c291243fbe4f3cc72b497))
- **contracts:** add streamFileBatch + finalizeSignals to EnrichmentProvider
  ([88c6cb3](https://github.com/artk0de/TeaRAGs-MCP/commit/88c6cb335460642e9ad26305932460de4fbf11dc))
- **contracts:** add WorkerEnrichmentDescriptor + onRelease to
  EnrichmentProvider
  ([8d37a12](https://github.com/artk0de/TeaRAGs-MCP/commit/8d37a12d54e441890456c8351e5e972f2e727208))
- **contracts:** EnrichmentExecutor.releaseCollection + inline no-op
  ([11cfb61](https://github.com/artk0de/TeaRAGs-MCP/commit/11cfb61df673ff26a9e4ce663e1a74b8a8f7382c))
- **contracts:** language-domain component interfaces + SymbolIdComposer +
  kernel
  ([f82cbec](https://github.com/artk0de/TeaRAGs-MCP/commit/f82cbec4213657d1c4bdd96d758a12767ff3b2a6))
- **contracts:** per-language capability interfaces + factory skeleton
  ([2b94e17](https://github.com/artk0de/TeaRAGs-MCP/commit/2b94e1782742f966a3c6d1db9c96392defe63720))
- **infra:** add file-classification single source of truth (classify)
  ([64b28ff](https://github.com/artk0de/TeaRAGs-MCP/commit/64b28ffca01c70e6ff0f4bf056f926e39e70f37b))
- **ingest:** enrichment worker entry + protocol with provider cache
  ([603d142](https://github.com/artk0de/TeaRAGs-MCP/commit/603d14202bcb97b81fb77ad581944b175e2afa99))
- **ingest:** enrichmentScope helper bridging classification + shouldEnrich
  ([727b8ff](https://github.com/artk0de/TeaRAGs-MCP/commit/727b8ff6a130473d23aa54e0b713b09158ee694c))
- **ingest:** report policy-skipped files as ignoredFiles, separate from
  missedFiles
  ([9ca0f07](https://github.com/artk0de/TeaRAGs-MCP/commit/9ca0f0799c7dfd5bc9ef90709181e24ef63b04f6))
- **ingest:** skip chunk-churn for non-full enrichment scope
  ([b075d56](https://github.com/artk0de/TeaRAGs-MCP/commit/b075d5680932440cdf6c306214e2cec9a6403b79))
- **ingest:** skip scope=none files from file-level enrichment
  ([b534c2c](https://github.com/artk0de/TeaRAGs-MCP/commit/b534c2c92a13c809776f4fd367b3e35186b25079))
- **ingest:** streaming per-batch enrichment, no prefetch gate, codegraph defer
  ([e2b44ab](https://github.com/artk0de/TeaRAGs-MCP/commit/e2b44ab843368f26b945adf6333b18ebe34c9819))
- **ingest:** wire workerDescriptor for git + codegraph enrichment providers
  ([bbeba70](https://github.com/artk0de/TeaRAGs-MCP/commit/bbeba70038120472beb293c0ee74316c4b52b47e))
- **ingest:** wire WorkerPoolEnrichmentExecutor as production default
  ([5f61b11](https://github.com/artk0de/TeaRAGs-MCP/commit/5f61b11c224362ea78d2028d4df6348109536f0c))
- **ingest:** WorkerPoolEnrichmentExecutor with affinity routing + release
  ([88e1d9a](https://github.com/artk0de/TeaRAGs-MCP/commit/88e1d9ae2084ab3d8fd3053c2828bb7355047587))
- **language:** real LanguageFactory + legacyAdapter (dormant)
  ([951e3a0](https://github.com/artk0de/TeaRAGs-MCP/commit/951e3a06f081b04fa1819b29c182858a484fc17f))
- **trajectory:** codegraph shouldEnrich — generated + test none
  ([80c6e5c](https://github.com/artk0de/TeaRAGs-MCP/commit/80c6e5cd89b30de3b4dccfc2d41d14ed57c40a0d))
- **trajectory:** codegraph stream extraction + file-only finalizeSignals + leak
  fix
  ([b1f6228](https://github.com/artk0de/TeaRAGs-MCP/commit/b1f622837d709e4c2be3a2a9428c66870dd3b28b))
- **trajectory:** codegraph worker-pool seam + onRelease
  ([0afa57a](https://github.com/artk0de/TeaRAGs-MCP/commit/0afa57a7a4caf10d7b2331e379d6527b980e1eaf))
- **trajectory:** git provider factory + serializable GitWorkerConfig
  ([6f914fc](https://github.com/artk0de/TeaRAGs-MCP/commit/6f914fce02d1db10e375e93aaeb1afb7cd707ef6))
- **trajectory:** git shouldEnrich — generated none, docs file-only
  ([2bf832b](https://github.com/artk0de/TeaRAGs-MCP/commit/2bf832b5223059fe73d88b31b327fc39a326bd4b))
- **trajectory:** git streamFileBatch + empty finalizeSignals
  ([cee85b1](https://github.com/artk0de/TeaRAGs-MCP/commit/cee85b1ab711a96f2996302d55150204bdea51c2))

### Bug Fixes

- **adapters:** cache per-collection symbolTable in the daemon write path
  ([a32b553](https://github.com/artk0de/TeaRAGs-MCP/commit/a32b553ae3cf11cb88fc57b601185364f3b84fe1))
- **chunker:** extract abstract class methods as chunks
  ([8d26612](https://github.com/artk0de/TeaRAGs-MCP/commit/8d26612306976feebbc90e5aea3a8fdf1bf1a2a3))
- **chunker:** extract Object.defineProperty getters/setters in JS walker
  ([d04eb56](https://github.com/artk0de/TeaRAGs-MCP/commit/d04eb569e7e58488a67bcfe78d41ef60b3df4502))
- **cli:** exit prime process after digest to unhang SessionStart hook
  ([a05631a](https://github.com/artk0de/TeaRAGs-MCP/commit/a05631a9dc4bdf2f109cd7089dc58f8b5014f265))
- **codegraph:** compute isHub against collection p95 at index time
  ([8337b13](https://github.com/artk0de/TeaRAGs-MCP/commit/8337b13a863bbf1295c7e53ecd91a924d0cd0fc9))
- **codegraph:** create Qdrant payload indexes for codegraph filter paths
  ([078778a](https://github.com/artk0de/TeaRAGs-MCP/commit/078778abf0c054418122173938b5124c64b0e5e8))
- **codegraph:** daemon releases DuckDB lock on idle (cache client per
  collection + bounded shutdown)
  ([4bb5e77](https://github.com/artk0de/TeaRAGs-MCP/commit/4bb5e77afa9332ed625088a19ea9e887a3174404))
- **codegraph:** emit external target for Python self.field calls on known
  stdlib types
  ([608e28e](https://github.com/artk0de/TeaRAGs-MCP/commit/608e28ed26450946696113546f9ba43d6e251065)),
  closes
  [CharSequence#charAt](https://github.com/artk0de/CharSequence/issues/charAt)
- **codegraph:** emit Rust localBindings and struct field types for receiver
  resolution
  ([743171f](https://github.com/artk0de/TeaRAGs-MCP/commit/743171fa4f7bad4e50fd359438ccc4425bc5f973)),
  closes [#member](https://github.com/artk0de/TeaRAGs-MCP/issues/member)
- **codegraph:** full-proxy reads through daemon
  (getCallers/getCallees/findCycles)
  ([43c624c](https://github.com/artk0de/TeaRAGs-MCP/commit/43c624cf432b6030ad69036380b33be21134f96d))
- **codegraph:** only treat CapWords RHS as Python constructor field type
  ([e8fda06](https://github.com/artk0de/TeaRAGs-MCP/commit/e8fda068887de5e43e6a414b4ebc4d092554a4b4))
- **codegraph:** proxy full GraphDbClient surface through daemon + ensure daemon
  on reads
  ([4464ad8](https://github.com/artk0de/TeaRAGs-MCP/commit/4464ad88374021c40aaf9587eafee7d453b415aa))
- **codegraph:** read derived signals from nested Qdrant payload shape
  ([34f886a](https://github.com/artk0de/TeaRAGs-MCP/commit/34f886aedf7f3582f5dc91bcc70023889d18a04e))
- **codegraph:** record TS named import specifiers for receiver resolution
  ([5ab7d75](https://github.com/artk0de/TeaRAGs-MCP/commit/5ab7d750987d4877381654925d9bc6fba28ab223))
- **codegraph:** resolve alias to active versioned collection in graph read path
  ([baf6ecf](https://github.com/artk0de/TeaRAGs-MCP/commit/baf6ecf6aa4091919695171025cc0a56f441ec91)),
  closes
  [EnrichmentApplier#applyChunkSignals](https://github.com/artk0de/EnrichmentApplier/issues/applyChunkSignals)
- **codegraph:** resolve calls on typed function parameters in TS
  ([2b37bd7](https://github.com/artk0de/TeaRAGs-MCP/commit/2b37bd723d7b9f3ff910c1b60a888a4c16d5dfe4))
- **codegraph:** resolve Go vars bound to function return types
  ([18027ff](https://github.com/artk0de/TeaRAGs-MCP/commit/18027ff64256dc338e7f464799bfa08671a19a88)),
  closes [Engine#Use](https://github.com/artk0de/Engine/issues/Use)
  [Engine#With](https://github.com/artk0de/Engine/issues/With)
- **codegraph:** resolve java.lang static calls via auto-import whitelist
  ([6d6c4ab](https://github.com/artk0de/TeaRAGs-MCP/commit/6d6c4ab19d8848537e224e225a43358a83bd92aa)),
  closes
  [CharSequence#charAt](https://github.com/artk0de/CharSequence/issues/charAt)
- **codegraph:** resolve same-file bound-type method on cross-file type-name
  collision
  ([5ae7cec](https://github.com/artk0de/TeaRAGs-MCP/commit/5ae7cec2fdb3249a29f718ecf58a0d0dc4b98f56)),
  closes [Parser#parse](https://github.com/artk0de/Parser/issues/parse)
  [Parser#parse](https://github.com/artk0de/Parser/issues/parse)
  [Parser#parse](https://github.com/artk0de/Parser/issues/parse)
- **codegraph:** track Go receiver and local var types for call resolution
  ([7ed1afa](https://github.com/artk0de/TeaRAGs-MCP/commit/7ed1afa1735fb459d99d651a4f01b19d0c37b195))
- **codegraph:** track Java parameter, field and local var types for call
  resolution
  ([b33d239](https://github.com/artk0de/TeaRAGs-MCP/commit/b33d239c7d8722276831d57c4b0bb04458104839))
- **codegraph:** write bare payload inner keys so Qdrant filters resolve
  ([772b6fb](https://github.com/artk0de/TeaRAGs-MCP/commit/772b6fb69d5dc50ddfe00a481f5d59c5c863ee12))
- **duckdb:** cap write-connection memory_limit (default 2GB) + verify it
  applied
  ([ab85e67](https://github.com/artk0de/TeaRAGs-MCP/commit/ab85e67b57c31174b62160458f59519c71ae3b6f))
- **explore:** preserve codegraph section in find_symbol outline + cover
  perLanguage stats
  ([ae55b29](https://github.com/artk0de/TeaRAGs-MCP/commit/ae55b29981786a12a90e2074e2b63d8bf8cc3e42))
- **git:** own-copy blame fields + release blameByRelPath after chunk enrichment
  ([4cf151f](https://github.com/artk0de/TeaRAGs-MCP/commit/4cf151f3377d296ae6b057cc1feb43514592b465))
- **hooks:** preserve full tool_input in Agent PreToolUse updatedInput
  ([a48b7de](https://github.com/artk0de/TeaRAGs-MCP/commit/a48b7de61f3115b6682cb63a501ce2f77a5bc5ce))
- **ingest:** apply enrichment policy on backfill + recovery + unenriched count
  ([7e49de6](https://github.com/artk0de/TeaRAGs-MCP/commit/7e49de66f2497206937333afa485b085e0372d44))
- **ingest:** await pre-reindex recovery so degraded markers clear (8tp8)
  ([f507414](https://github.com/artk0de/TeaRAGs-MCP/commit/f507414e15870ab086a32d151c848db88c566c70))
- **ingest:** count matchedFiles as unique paths (was double-counting across
  enrichment passes)
  ([17a72cb](https://github.com/artk0de/TeaRAGs-MCP/commit/17a72cb39c571d999823ab2cdddd0539191cb389))
- **ingest:** decouple per-provider enrichment so all 4 kinds run parallel
  ([01be8a6](https://github.com/artk0de/TeaRAGs-MCP/commit/01be8a622ed43dbd076f4028755a6bbbe3e2b962))
- **ingest:** delete codegraph DB on alias-swap + sweep ancient orphans
  ([263573d](https://github.com/artk0de/TeaRAGs-MCP/commit/263573de09449547e4e7bcd4da2abb983b771c0e))
- **ingest:** delete codegraph DuckDB files with Qdrant orphan collections
  ([0117819](https://github.com/artk0de/TeaRAGs-MCP/commit/011781977cd643b1495fa29bd7defe498f0f4759))
- **ingest:** derive reindex version from Qdrant, not snapshot
  ([f45a424](https://github.com/artk0de/TeaRAGs-MCP/commit/f45a424f44354bbb596f1383f251b8abbbaf22b6))
- **ingest:** drive deferred-provider extraction in streaming + stamp
  unmatched + retime leak clear
  ([bba7673](https://github.com/artk0de/TeaRAGs-MCP/commit/bba76733c6ea77a2dacb162328b2d0cc2b482c01))
- **ingest:** heartbeat at applier apply-site to cover all enrichment phases
  (post-flush included)
  ([db88bb1](https://github.com/artk0de/TeaRAGs-MCP/commit/db88bb1e38f363bb43f5e3a8b0ba9d5bf90c94d7))
- **ingest:** heartbeat during post-embedding enrichment tail (git chunk churn +
  deferred codegraph)
  ([97f3805](https://github.com/artk0de/TeaRAGs-MCP/commit/97f3805799321b111bb2c0401c300564662dc278))
- **ingest:** heartbeat per-apply during git chunk churn drain (covers the real
  false-stall window)
  ([9be7401](https://github.com/artk0de/TeaRAGs-MCP/commit/9be740189c48d9a9f0f1dc80a26564e35d4145f0))
- **ingest:** heartbeat run.lastProgressAt so long enrichment isn't
  false-flagged stalled
  ([5c3e428](https://github.com/artk0de/TeaRAGs-MCP/commit/5c3e4284304992d754d7e4ccd745423e73244209))
- **ingest:** keep codegraph daemon alive across the index run
  ([fbc2aeb](https://github.com/artk0de/TeaRAGs-MCP/commit/fbc2aeb888f736ac67f40bd1384de75aa241c57d))
- **ingest:** pin git enrichment per-collection to restore blame/churn reuse
  ([a8d2ec4](https://github.com/artk0de/TeaRAGs-MCP/commit/a8d2ec49ded09f9c618fb2affdb70f3c5120dfad))
- **ingest:** report chunk-enrichment duration as wall-clock, not summed
  per-batch (wait+work)
  ([41f9a14](https://github.com/artk0de/TeaRAGs-MCP/commit/41f9a14945b353f819882c7503c8e454f797bd92))
- **ingest:** reset chunk-enrichment duration per run (was accumulating across
  daemon lifetime)
  ([08b1440](https://github.com/artk0de/TeaRAGs-MCP/commit/08b1440aa3d8c65024c4b84ceda5ba7431f3fd74))
- **ingest:** retry enrichment writes + residual backfill; align unenriched
  filters
  ([605ca82](https://github.com/artk0de/TeaRAGs-MCP/commit/605ca827e2a76702e42f4ae536f0de1c9878fa34))
- **ingest:** retry ollama health probe before fatal abort
  ([566fa8f](https://github.com/artk0de/TeaRAGs-MCP/commit/566fa8faa5419bda5d7341af695a562f6cef853a))
- **ingest:** run git enrichment inline (in-process), reverting worker-pool
  affinity
  ([42a53a5](https://github.com/artk0de/TeaRAGs-MCP/commit/42a53a5d46a68e4333de9f4d4a757441b095a444))
- **ingest:** stateless work must not steal affinity-pinned ThreadPool thread
  ([6fe3490](https://github.com/artk0de/TeaRAGs-MCP/commit/6fe34902c4efba44bc472838b5fb9fa83a0e84a9))
- **ingest:** strip non-serializable concurrencySemaphore in enrichment worker
  ([4cf30a7](https://github.com/artk0de/TeaRAGs-MCP/commit/4cf30a727862aaff553805f63f1f19b1d49fb7c5))
- **ingest:** terminal-only enrichment markers + runId staleness
  ([a93e3db](https://github.com/artk0de/TeaRAGs-MCP/commit/a93e3dbb83c297d3d837db501bed00b68d90e3a9))
- **qdrant:** re-resolve embedded daemon on reconnect instead of attach-only
  ([8222198](https://github.com/artk0de/TeaRAGs-MCP/commit/8222198b511d641fdd5bb1e29d44968c49c9a90d))
- **registry:** detect stale project aliases and rename alias on re-register
  ([63d9be2](https://github.com/artk0de/TeaRAGs-MCP/commit/63d9be2a460e0c2efb0970f04deb432ca174437f))
- **registry:** make prime registry-first override actually propagate to
  embedding factory
  ([56e9757](https://github.com/artk0de/TeaRAGs-MCP/commit/56e97578dbbfd58ea884d282338f4b62b044b0f1))
- **registry:** track embedding endpoints, surface both URLs in prime digest
  ([42f445e](https://github.com/artk0de/TeaRAGs-MCP/commit/42f445e6080bd1d1d0b6626313418a1027d757f5))

### Performance Improvements

- **git:** persistent git cat-file --batch + remove isomorphic-git
  ([288268a](https://github.com/artk0de/TeaRAGs-MCP/commit/288268a76e39e025252243989a905f94d064b538))
- **ingest:** share one cat-file reader across git chunk batches per run (kc93)
  ([28a8358](https://github.com/artk0de/TeaRAGs-MCP/commit/28a8358a4aff50bd10bddcd1baa98e95afcdf3cf))

### Documentation

- **architecture:** align domain-boundaries.md with full layer matrix
  (tea-rags-mcp-dmto)
  ([9e3c48e](https://github.com/artk0de/TeaRAGs-MCP/commit/9e3c48e2ac3594c0fdf3ae839b969261253d106a))
- **architecture:** dependency direction guard — full layer matrix design
  ([6baba21](https://github.com/artk0de/TeaRAGs-MCP/commit/6baba21716af27e999847533123e7a57e29fccb2))
- **architecture:** dependency direction guard implementation plan
  (tea-rags-mcp-3u5s)
  ([8d3afce](https://github.com/artk0de/TeaRAGs-MCP/commit/8d3afcec68f214927e42362eb4814c1e536b00d7))
- **chunker:** add domains/language consolidation design spec
  ([750ca4f](https://github.com/artk0de/TeaRAGs-MCP/commit/750ca4f757f1b60632b7a07809a79d38c7ffd2c6))
- codegraph daemon keep-alive design + terminal-only markers impl plan
  ([abeb34e](https://github.com/artk0de/TeaRAGs-MCP/commit/abeb34e1d7944ad4b102e8c0008cf2aa70af6858))
- **codegraph:** codegraph DuckDB daemon design spec (lock fix)
  ([44b29a5](https://github.com/artk0de/TeaRAGs-MCP/commit/44b29a591d0aae8fdcb0893c1bb1a127e7aceb6a))
- **codegraph:** daemon implementation plan + spec transport correction
  ([250fdf3](https://github.com/artk0de/TeaRAGs-MCP/commit/250fdf3bc9a6e4df29c3a89ec29d5a8078dacadf))
- **codegraph:** design for agent-assisted sink edges (dynamic dispatch
  resolution)
  ([eb613f3](https://github.com/artk0de/TeaRAGs-MCP/commit/eb613f38f52b0f57e0cb2b16a21cb594410b4787))
- **codegraph:** multi-target dispatch resolution design spec
  ([35cc578](https://github.com/artk0de/TeaRAGs-MCP/commit/35cc578f22ff2c6a926b41ff0d22e4745c989db1))
- **codegraph:** trace_path execution-path-tracing design (Slice 6)
  ([fec740d](https://github.com/artk0de/TeaRAGs-MCP/commit/fec740d619161e33a4d120d90a7c8640620ed5e7))
- git cat-file --batch rule + streaming-enrichment spec & plan
  ([b1f4163](https://github.com/artk0de/TeaRAGs-MCP/commit/b1f4163e4457336b3649c01e615b6559c8d732c6))
- **ingest:** clarify codegraph deferred-chunk ordering rationale
  ([b150e4d](https://github.com/artk0de/TeaRAGs-MCP/commit/b150e4dc8750a5dd08b2475700168ee8609b7933))
- **ingest:** explicit enrichmentExecutor mode flag (inline|worker)
  ([4bee542](https://github.com/artk0de/TeaRAGs-MCP/commit/4bee542ac108142a59a59b3cead5e158dd99af15))
- **ingest:** implementation plan for unified enrichment worker pool
  ([d68196f](https://github.com/artk0de/TeaRAGs-MCP/commit/d68196f5af9c9f5e1e3cac60c0987e22e8e73fad))
- **ingest:** mark Task 3 done, decompose Task 4 into 4a-4d
  ([3fb219c](https://github.com/artk0de/TeaRAGs-MCP/commit/3fb219cb5e6e56b22ecb9e870e520141abe540bf))
- **ingest:** resolve Phase 2 design gap — SerializableProviderSpec + onRelease
  lifecycle
  ([02fcce8](https://github.com/artk0de/TeaRAGs-MCP/commit/02fcce87dc6ad0ffd8523cfb66753a916a2dbba3))
- **ingest:** unified enrichment worker pool design
  ([20cdd66](https://github.com/artk0de/TeaRAGs-MCP/commit/20cdd661f89ca20bf79cb64f32940946822184d1))
- **license:** per-module attribution headers + own provider script
  ([944d34c](https://github.com/artk0de/TeaRAGs-MCP/commit/944d34c568aee910df69644fc5171b69e9249dfe))
- **plan:** record Task 1 inline revert (affinity was 4x slower live) + cat-file
  perf follow-up
  ([bc5b1fd](https://github.com/artk0de/TeaRAGs-MCP/commit/bc5b1fdf3974b242fb0ffd283bcfa2b66750f11d))
- **plan:** ruby/dsl catalogue implementation plan
  ([7784b5f](https://github.com/artk0de/TeaRAGs-MCP/commit/7784b5fcfac27cb520972e102c68660b2fda160a))
- **plan:** tree-sitter engine consolidation implementation plan
  ([192059b](https://github.com/artk0de/TeaRAGs-MCP/commit/192059b2b02926669f76c0946b93149e9fe20b84))
- **presets:** codegraph chunk-level rerank presets design spec
  ([9b4e898](https://github.com/artk0de/TeaRAGs-MCP/commit/9b4e898e5269226c79e827788ce3747c4b4f5ab8))
- **rules:** add domains-language architecture rule
  ([c816983](https://github.com/artk0de/TeaRAGs-MCP/commit/c8169833a4832312f9abee472d988e0b93795c88))
- **skill:** fix get_callers symbolId example to use # for instance method
  ([c9cc26b](https://github.com/artk0de/TeaRAGs-MCP/commit/c9cc26ba61ead77a0a9036c8f9acae43cc986b86))
- **spec:** codegraph chunk-defer design amendment (Option A)
  ([ea4fa84](https://github.com/artk0de/TeaRAGs-MCP/commit/ea4fa847d6bb855066f76b1bd634e81519204125))
- **spec:** per-file enrichment policy design + implementation plan
  ([db5b8d4](https://github.com/artk0de/TeaRAGs-MCP/commit/db5b8d42b4f1249abb4fbf145ab8fac3d27d4150))
- **spec:** ruby DSL descriptor — full class-body catalogue, RSpec excluded
  ([9d88f3a](https://github.com/artk0de/TeaRAGs-MCP/commit/9d88f3a90c8006afe0dc2a29e46f45997e65606e))
- **spec:** ruby DSL descriptor — method-declaring macro unification
  ([631fbd3](https://github.com/artk0de/TeaRAGs-MCP/commit/631fbd3ebff4071bebfeac772705a48117a11420))
- **specs:** add TS resolver in-code resolution strategy design + naming rule
  ([c1227e4](https://github.com/artk0de/TeaRAGs-MCP/commit/c1227e449e72874c7166629e9f5d6fda56a123c2))
- **specs:** correct keep-alive wiring to EnrichmentCoordinator (not
  IngestFacade)
  ([6993fc1](https://github.com/artk0de/TeaRAGs-MCP/commit/6993fc1cfc4e46629d0c4d02ebcef10bbaf52e00))
- **specs:** enrichment worker-pool wiring + force-reindex versioning +
  health-check design
  ([f063d00](https://github.com/artk0de/TeaRAGs-MCP/commit/f063d006fe9892101271cf4907091e6c9117c9cc))
- **specs:** refine TS resolver spec + naming rule wording
  ([3c19c64](https://github.com/artk0de/TeaRAGs-MCP/commit/3c19c6443044c9d52ff3a7a4260fdafbd86cce89))
- **specs:** terminal-only enrichment markers + runId-staleness design
  ([c020a9e](https://github.com/artk0de/TeaRAGs-MCP/commit/c020a9e0cc96b368badc551219b2fed0b4770131))
- **spec:** tree-sitter engine consolidation — language-agnostic ChunkClassifier
  ([f61a05a](https://github.com/artk0de/TeaRAGs-MCP/commit/f61a05a819feb78a008d4c81384006cf57132ed4))

### Code Refactoring

- **chunker:** consume LanguageFactory instead of LANGUAGE_DEFINITIONS
  ([0d948b2](https://github.com/artk0de/TeaRAGs-MCP/commit/0d948b223d8bdec973b56074232297879342a3f1))
- **chunker:** de-language-name macro-walk, drive scope from kernel
  ([ee11553](https://github.com/artk0de/TeaRAGs-MCP/commit/ee11553c22d60032fa495e626b1296b8e2d72d01))
- **chunker:** extract Go symbolId convention into shared goSymbolOf
  ([a57a5ff](https://github.com/artk0de/TeaRAGs-MCP/commit/a57a5ff3cbe28ab0c8d06d7d8ef05c18dd63d6ec))
- **chunker:** inject SymbolIdComposer + move worker composition root to
  api/internal
  ([e7411a7](https://github.com/artk0de/TeaRAGs-MCP/commit/e7411a775700b8b80fb73825934fba104581387d))
- **chunker:** native bash LanguageProvider vertical
  ([4aab0d1](https://github.com/artk0de/TeaRAGs-MCP/commit/4aab0d1500792bdc6d8bf62c3fa05894e6d34395))
- **chunker:** native go LanguageProvider vertical
  ([8a094bb](https://github.com/artk0de/TeaRAGs-MCP/commit/8a094bbd529cf1c10948e0c4922582e7cb883546))
- **chunker:** native java LanguageProvider vertical
  ([9ec3c35](https://github.com/artk0de/TeaRAGs-MCP/commit/9ec3c353ca56b83906cf5a41cab10521ed7cc240))
- **chunker:** native javascript LanguageProvider vertical
  ([0f024c8](https://github.com/artk0de/TeaRAGs-MCP/commit/0f024c860dd8e4e10e2d8ee8db412a13ad3fe2cc))
- **chunker:** native markdown LanguageProvider vertical
  ([11289c0](https://github.com/artk0de/TeaRAGs-MCP/commit/11289c0a5fa710c6922939445d76226e428bbddb))
- **chunker:** native python LanguageProvider vertical
  ([6a3fded](https://github.com/artk0de/TeaRAGs-MCP/commit/6a3fdeda5029a5deafdc7a3f57766dca34d39837))
- **chunker:** native rust LanguageProvider vertical
  ([07b09cd](https://github.com/artk0de/TeaRAGs-MCP/commit/07b09cd782d89b06b1630ac10ce68b8783709866))
- **chunker:** native typescript LanguageProvider vertical
  ([cfc4c19](https://github.com/artk0de/TeaRAGs-MCP/commit/cfc4c19994e386360d8c6344199138b6d8ea674a))
- **chunker:** real LanguageFactory + in-thread worker (restore multithread)
  ([f8f84b6](https://github.com/artk0de/TeaRAGs-MCP/commit/f8f84b6a806bea2be22f48326ab6f09fd4ae5122))
- **chunker:** remove legacy language adapter — all languages native
  ([7a83c49](https://github.com/artk0de/TeaRAGs-MCP/commit/7a83c49ec6f789ae1d852f0d7f1fd6ba9dc21ca0))
- **chunker:** route chunkSingleNode through ChunkClassifier, remove language===
  branches
  ([9dd292f](https://github.com/artk0de/TeaRAGs-MCP/commit/9dd292f30cd4b5e1801e65d381ae8a0d620ec200))
- **chunker:** ruby macro synthesis reads the dsl catalogue
  ([76ef74c](https://github.com/artk0de/TeaRAGs-MCP/commit/76ef74c30f46e7fdab11f9c6f27ed2dabb1d3c4d))
- **chunker:** ruby walker alias redirect reads the dsl catalogue
  ([f63bd78](https://github.com/artk0de/TeaRAGs-MCP/commit/f63bd7876f96185296e49d8c8244331b5e91427f))
- **chunker:** thread classifier through LanguageConfig (additive)
  ([6d032af](https://github.com/artk0de/TeaRAGs-MCP/commit/6d032af609e971bf47078a409e5f525ad66c7bae))
- **cli:** import core only via api/public + bootstrap (tea-rags-mcp-ipjr)
  ([8e1bc89](https://github.com/artk0de/TeaRAGs-MCP/commit/8e1bc891ae2ec96e80a30d361a9ccdb489bcb98c))
- **codegraph:** consume LanguageFactory instead of LANGUAGES map
  ([b9c910d](https://github.com/artk0de/TeaRAGs-MCP/commit/b9c910d996564f7d475c885f72c34f09daa0b12e))
- **codegraph:** nest daemon under adapters/duckdb/daemon + remove
  adapter-&gt;domain imports
  ([86dc836](https://github.com/artk0de/TeaRAGs-MCP/commit/86dc836573c1ccf919f7c722d2371770de309b2a))
- **codegraph:** route symbolId through injected SymbolIdComposer
  ([0a079b8](https://github.com/artk0de/TeaRAGs-MCP/commit/0a079b8961a62be6a68086eab273a50eab0c9862)),
  closes [Type#member](https://github.com/artk0de/Type/issues/member)
- **codegraph:** ruby name-of shared macros read the dsl catalogue
  ([a753d8b](https://github.com/artk0de/TeaRAGs-MCP/commit/a753d8bc003a57a431b6fe30ce80de7096883d2e))
- **contracts:** finalizeSignals file-only + defersChunkEnrichment flag
  ([8d5d9b0](https://github.com/artk0de/TeaRAGs-MCP/commit/8d5d9b0ae557fd7e262bbf6c7d7bd7707d3e85e2))
- **contracts:** relocate ChunkLookupEntry + ProviderRunMetrics into contracts;
  tighten guard against core/types
  ([16dceee](https://github.com/artk0de/TeaRAGs-MCP/commit/16dceee9a7b3c12204f95df7b992843dcbec2f04))
- **contracts:** relocate IngestCodeConfig + EnrichmentHealth types into
  contracts (tea-rags-mcp-uamh)
  ([f99f5cf](https://github.com/artk0de/TeaRAGs-MCP/commit/f99f5cffeed8821a68203f7af029ecdef13b0ed0))
- **explore:** receive TrajectoryFilterBuilder via DI, drop direct trajectory
  import (tea-rags-mcp-cuow)
  ([bdb644f](https://github.com/artk0de/TeaRAGs-MCP/commit/bdb644f3d5f083c33c59aeaba30378674fddd137))
- **infra:** relocate ConfigError hierarchy from bootstrap to core/infra
  (tea-rags-mcp-p7mr)
  ([9344854](https://github.com/artk0de/TeaRAGs-MCP/commit/934485472547a410c8ec69f2778ab1329db6080e))
- **ingest:** clarify drain heartbeat wrapper; document deferred codegraph
  window
  ([1e7de5e](https://github.com/artk0de/TeaRAGs-MCP/commit/1e7de5e0bb10bd3fd2bae4cfab691d9053c93968))
- **ingest:** complete native ruby LanguageProvider vertical
  ([9e63d07](https://github.com/artk0de/TeaRAGs-MCP/commit/9e63d077531f473962765466fb1fc6ccd443ed4b))
- **ingest:** drop vestigial bulk-prefetch overlap metrics; fix
  debug-pipeline-log Rule 7
  ([1ac2489](https://github.com/artk0de/TeaRAGs-MCP/commit/1ac2489209e9a964156bebe0acbb283039553320))
- **ingest:** extract generic ThreadPool from ChunkerPool with routingKey
  affinity
  ([786d021](https://github.com/artk0de/TeaRAGs-MCP/commit/786d021afd5317b5921e170a53bfc2dfcdbf4060))
- **ingest:** introduce EnrichmentExecutor seam with InlineEnrichmentExecutor
  ([3ea227c](https://github.com/artk0de/TeaRAGs-MCP/commit/3ea227cb1fae1b17de723f85a20ae10d8d11df07))
- **language:** decompose call resolvers into SymbolResolutionStrategy chain
  ([e091d0a](https://github.com/artk0de/TeaRAGs-MCP/commit/e091d0a79801a17f3392633e054287d8b04adf27))
- **language:** merge SymbolResolutionStrategy decomposition (all 7 languages)
  ([faa120a](https://github.com/artk0de/TeaRAGs-MCP/commit/faa120ae7bba64e718f65cc0b079d35c870dbfd5))
- **language:** rename LanguageFactoryImpl→LanguageFactory,
  interface→LanguageFactoryDescriptor
  ([5475da9](https://github.com/artk0de/TeaRAGs-MCP/commit/5475da96afb5eddd34a62b27045b6851db574274))
- **mcp:** import core only via api/public (tea-rags-mcp-bk6g)
  ([c8e19be](https://github.com/artk0de/TeaRAGs-MCP/commit/c8e19befbcabd167e78d21e0ca574e753774887f))
- **trajectory:** codegraph uses isDebug+console.error instead of ingest
  pipelineLog (tea-rags-mcp-q3a4)
  ([71bf6ea](https://github.com/artk0de/TeaRAGs-MCP/commit/71bf6ea7b142014f1054fc0f7db4a0713684e947))
- **trajectory:** source codegraph generated/test patterns from infra (dedup)
  ([12c7837](https://github.com/artk0de/TeaRAGs-MCP/commit/12c7837e83d32b1a9edf23190254923e4b79e2bb))

### Chores

- **merge:** codegraph enrichment opt-in (beta) + docs
  ([30cb546](https://github.com/artk0de/TeaRAGs-MCP/commit/30cb5469d41bddbaa22e92e5da18d5eed77317b6))

## [1.28.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.27.0...v1.28.0) (2026-05-24)

### Features

- **adapters:** add DuckDB graph adapter + migration runner with cg_symbols
  schema
  ([350e18c](https://github.com/artk0de/TeaRAGs-MCP/commit/350e18c0340c5c3e0b028436fb9708926a811836))
- **api:** integrate codegraph slice 1 — App methods, GraphFacade, MCP tools
  ([9bd4079](https://github.com/artk0de/TeaRAGs-MCP/commit/9bd40791e2591a8495c607e02ea68e505ef95a37))
- **chunker:** add TypeScript extraction walker (file-level, sink wiring
  deferred to T10)
  ([762a92e](https://github.com/artk0de/TeaRAGs-MCP/commit/762a92e166b26f1f5c9025fb83d5c97650bdab70))
- **codegraph:** add 7 derived signals and blastRadius preset
  ([bb6659b](https://github.com/artk0de/TeaRAGs-MCP/commit/bb6659b2f72b91de5082e0170eb89abdbdfe88f3))
- **codegraph:** add CodegraphEnrichmentProvider with sink + file/chunk signals
  ([4d6cac1](https://github.com/artk0de/TeaRAGs-MCP/commit/4d6cac1f097846145355cad362e0f23d1129b462))
- **codegraph:** add in-memory GlobalSymbolTable
  ([99bb461](https://github.com/artk0de/TeaRAGs-MCP/commit/99bb4612106364a8c073a1980f548f30ac5945e6))
- **codegraph:** add SymbolsTrajectory and L1 family factory
  ([603ccc5](https://github.com/artk0de/TeaRAGs-MCP/commit/603ccc545ca9b9c8583bbfc71d3f8f32094f27ca))
- **codegraph:** add TypeScript CallResolver with tsconfig path mapping
  ([87641fb](https://github.com/artk0de/TeaRAGs-MCP/commit/87641fb33047a960ca4d1fb1c2805c183225a5fc))
- **codegraph:** comprehensive multi-language corner-case fixes
  (JS/Python/Go/Java/Rust)
  ([6910269](https://github.com/artk0de/TeaRAGs-MCP/commit/69102692aef7c9b22d84d38273cd10bd5127a3f8))
- **codegraph:** exclude Rails db/schema.rb from graph layer
  ([d4bd523](https://github.com/artk0de/TeaRAGs-MCP/commit/d4bd523af80ff811f7b9e19a2323f5a38dc3f8b9))
- **codegraph:** find_cycles MCP tool + Tarjan SCC over file and method graphs
  ([efa72ca](https://github.com/artk0de/TeaRAGs-MCP/commit/efa72cac51a29b3625099daf480eb93369ec7611))
- **codegraph:** PageRank method-graph signal + cg_symbols_metrics table
  ([dc3e404](https://github.com/artk0de/TeaRAGs-MCP/commit/dc3e4045cd54e2ae73adadef937066459b70861f))
- **codegraph:** per-collection DB pool, streaming spill, layered ignore, Python
  types
  ([d8e9e45](https://github.com/artk0de/TeaRAGs-MCP/commit/d8e9e454eff9489fc4a913db729a9dabaac17e10))
- **codegraph:** persist symbol table to DuckDB with lazy hydration
  ([8f3f232](https://github.com/artk0de/TeaRAGs-MCP/commit/8f3f232d3ee1f961a537628d9ed21b91b5aff294))
- **codegraph:** polyglot walkers for JavaScript, Go, Java, Rust, Bash
  ([f01ce06](https://github.com/artk0de/TeaRAGs-MCP/commit/f01ce06b4346f65e4afc058daac6ac50d7c987e8))
- **codegraph:** Python + Ruby (Zeitwerk-aware) walkers + universal entryPoint
  composite
  ([ab41ab5](https://github.com/artk0de/TeaRAGs-MCP/commit/ab41ab5c5c615f447ca6c9c09af82772915458d7))
- **codegraph:** Ruby `class &lt;&lt; self` block → class methods
  ([40d2277](https://github.com/artk0de/TeaRAGs-MCP/commit/40d2277b6795deabe5fcaf8c47ba9ea22fe2b86c)),
  closes [Bar#inner](https://github.com/artk0de/Bar/issues/inner)
- **codegraph:** Ruby DSL macro synthetic symbols (attr\_\* + AR associations)
  ([56ebd77](https://github.com/artk0de/TeaRAGs-MCP/commit/56ebd777f7e6e4de2069f309226bce9197f1c104)),
  closes [#name](https://github.com/artk0de/TeaRAGs-MCP/issues/name)
  [#name](https://github.com/artk0de/TeaRAGs-MCP/issues/name)
  [#name](https://github.com/artk0de/TeaRAGs-MCP/issues/name)
  [#name](https://github.com/artk0de/TeaRAGs-MCP/issues/name)
  [#name](https://github.com/artk0de/TeaRAGs-MCP/issues/name)
  [#name_id](https://github.com/artk0de/TeaRAGs-MCP/issues/name_id)
- **codegraph:** Ruby inheritance + mixin walk in resolver (closes x3in, u17l)
  ([301c69e](https://github.com/artk0de/TeaRAGs-MCP/commit/301c69e9ae2cb743ead0610107fb388198ee7f2b))
- **codegraph:** Ruby local type tracking via constructor + AR finders + YARD
  ([e2c5092](https://github.com/artk0de/TeaRAGs-MCP/commit/e2c509220943aa6672758bb5667cdc9844ea584d))
- **codegraph:** Ruby send/&block / delegate / habtm / define_method + AR chain
  guard
  ([7373068](https://github.com/artk0de/TeaRAGs-MCP/commit/7373068cd5d71e5f1fde71a262e73bfee9d6324f)),
  closes [#name](https://github.com/artk0de/TeaRAGs-MCP/issues/name)
  [#a](https://github.com/artk0de/TeaRAGs-MCP/issues/a)
  [#b](https://github.com/artk0de/TeaRAGs-MCP/issues/b)
  [AbstractPolicy#result](https://github.com/artk0de/AbstractPolicy/issues/result)
- **codegraph:** transitiveImpact file signal via depth-capped reverse BFS
  ([004d18b](https://github.com/artk0de/TeaRAGs-MCP/commit/004d18bfee9c6b69fbd1b3d36397a3254a11b1b6))
- **codegraph:** wire end-to-end — env-driven CODEGRAPH_ENABLED + composition +
  bootstrap
  ([ee2570b](https://github.com/artk0de/TeaRAGs-MCP/commit/ee2570b6086bbafe11bf1bf9d48917b5e5e14f5f))
- **composite-presets:** D4 overrides + architecturalHub (codegraph-aware
  reranking)
  ([e4efbf2](https://github.com/artk0de/TeaRAGs-MCP/commit/e4efbf2cc8eab2797041a784638e59c322850727))
- **contracts:** add codegraph slice 1 contracts (FileExtraction, GraphDbClient,
  CallResolver)
  ([75c8ac1](https://github.com/artk0de/TeaRAGs-MCP/commit/75c8ac102c18d88cc7eafceeb8802238eebd1e21))
- **contracts:** handleDeletedPaths hook on EnrichmentProvider + coordinator
  dispatch
  ([63d9547](https://github.com/artk0de/TeaRAGs-MCP/commit/63d954755c4dcaf73d7a777ff96bf9d38beeaca5))
- **metrics:** per-provider EnrichmentMetrics with codegraph extraction stats
  ([5214014](https://github.com/artk0de/TeaRAGs-MCP/commit/5214014ad5444c9306851c8470ad777bbf25abd1))
- **presets:** introduce composite trajectory namespace and move blastRadius
  ([188a317](https://github.com/artk0de/TeaRAGs-MCP/commit/188a317b0ca2ed7b005197970878624c112162a2))
- **sync:** route file deletions through EnrichmentCoordinator before Qdrant
  ([fc34474](https://github.com/artk0de/TeaRAGs-MCP/commit/fc34474ec08c38d45a496118d670acc885315591))

### Bug Fixes

- **chunker:** inherit symbolId + chunkType in chunkOversizedNode subChunks
  ([d9e666f](https://github.com/artk0de/TeaRAGs-MCP/commit/d9e666fc87e44f1afaf95a83c46ccb2896bf6462))
- **codegraph:** aggregate classAncestors across all files (global pass-1 →
  pass-2)
  ([6d44896](https://github.com/artk0de/TeaRAGs-MCP/commit/6d4489684257fc3bdedbac77786113254e55da4a)),
  closes
  [PaginatableForm#page](https://github.com/artk0de/PaginatableForm/issues/page)
  [ProductsController#index](https://github.com/artk0de/ProductsController/issues/index)
  [IndexForm#search_params](https://github.com/artk0de/IndexForm/issues/search_params)
  [PaginatableForm#page](https://github.com/artk0de/PaginatableForm/issues/page)
- **codegraph:** end-to-end live MCP integration on tea-rags + chunk metric
  rename
  ([a286df0](https://github.com/artk0de/TeaRAGs-MCP/commit/a286df00bbc02d49ee53d1eae5502b5f94823707))
- **codegraph:** match qualified type name against scope tail in Ruby Step 0
  ([491e2f5](https://github.com/artk0de/TeaRAGs-MCP/commit/491e2f5b9e274916d8df893f6c13ef6ba2064ab4)),
  closes
  [IndexForm#search_params](https://github.com/artk0de/IndexForm/issues/search_params)
- **codegraph:** prefer Class.method over
  Class[#method](https://github.com/artk0de/TeaRAGs-MCP/issues/method) for
  Zeitwerk dispatch
  ([53f48e1](https://github.com/artk0de/TeaRAGs-MCP/commit/53f48e1d0c8485343a3140e914386853675a5a3d))
- **codegraph:** qualify Go methods + drop unsafe short-name fallback in Go/Java
  resolvers
  ([9965ae4](https://github.com/artk0de/TeaRAGs-MCP/commit/9965ae4fcb4f1311469d1212831f325a6caf1842))
- **codegraph:** use Record (not Map) for classAncestors to survive NDJSON spill
  ([13fad35](https://github.com/artk0de/TeaRAGs-MCP/commit/13fad35e84734e48f6cc91ff2d46c33f96d09356))
- **codegraph:** use Record (not Map) for classFieldTypes to survive NDJSON
  spill
  ([735744d](https://github.com/artk0de/TeaRAGs-MCP/commit/735744dcad7dedfcb64de0be9632f6da62c83e7e))
- **codegraph:** use Record (not Map) for classFieldTypes to survive NDJSON
  spill
  ([2908640](https://github.com/artk0de/TeaRAGs-MCP/commit/290864078324d3864ad972294cc1b84c9f9df7bb))
- **codegraph:** walk ancestors for Class.method calls in Zeitwerk branch (Ruby)
  ([13a2548](https://github.com/artk0de/TeaRAGs-MCP/commit/13a254838d2e851a846863451751f2a2477e83cc))
- **skills:** correct DSL test-chunker language list to include Ruby
  ([d87854a](https://github.com/artk0de/TeaRAGs-MCP/commit/d87854a8d5e2054450d6e89f717c2ca662662560))

### Documentation

- **codegraph:** implementation plan for symbols slice 1
  ([1a755cf](https://github.com/artk0de/TeaRAGs-MCP/commit/1a755cff7652d388844846e762cb0c352c067d23))
- **codegraph:** sync spec with plan-time refinements (walker, flat App,
  duckdb-node-api)
  ([2e12031](https://github.com/artk0de/TeaRAGs-MCP/commit/2e1203148605cebf4c810d6b870363e793d67bcb))
- **plan:** clarify composite preset directory + reclassify Slice 1 blastRadius
  ([bbf74df](https://github.com/artk0de/TeaRAGs-MCP/commit/bbf74df53502d53303ad8614539d65fbab5960a7))
- **specs:** clarify track separation in static-complexity spec
  ([8501af8](https://github.com/artk0de/TeaRAGs-MCP/commit/8501af80820e9d9b5e997537f0e4540c4b958f4d))
- **specs:** composite preset overrides instead of modifying trajectory presets
  ([8fdfac0](https://github.com/artk0de/TeaRAGs-MCP/commit/8fdfac017f7eeae6a057420f667dc0e9924eb79c))
- **specs:** plan static complexity + universal fan-graph + temporal coupling
  tracks
  ([c9436a2](https://github.com/artk0de/TeaRAGs-MCP/commit/c9436a2feff20ef2529acb08503826e1fb3e5b0e))

### Code Refactoring

- **codegraph:** move graph algorithms to trajectory/codegraph/infra; adapter
  becomes pure CRUD
  ([720c4d4](https://github.com/artk0de/TeaRAGs-MCP/commit/720c4d409aececd0a6aa56b1ff58d87025142a48))
- **facades:** drive IngestFacade enrichment providers from TrajectoryRegistry
  ([5c8b6a4](https://github.com/artk0de/TeaRAGs-MCP/commit/5c8b6a475f6600f673e3ec26255133907351e50a))
- **presets:** relocate fanOutPerLine to codegraph + add imports-field-semantics
  rule
  ([08367f6](https://github.com/artk0de/TeaRAGs-MCP/commit/08367f66d45fe5b2bac2e3e7db7c0d68d925503f))

## [1.27.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.26.0...v1.27.0) (2026-05-19)

### Features

- **rerank:** add find_similar to ProvenPreset tools list
  ([70c0695](https://github.com/artk0de/TeaRAGs-MCP/commit/70c069538d4023a92906a39bd90d4a2e19e8cbad))
- **tea-rags:** add extract-project-patterns recipe skill
  ([16546c5](https://github.com/artk0de/TeaRAGs-MCP/commit/16546c5acf251b6e0a4962df1a65025cdfc23566))

### Improvements

- **dinopowers:** wire extract-project-patterns into executing-plans per Task
  ([33bbd9c](https://github.com/artk0de/TeaRAGs-MCP/commit/33bbd9c922746612fc34e9c241c1a55f4f0ef0d7))
- **dinopowers:** wire extract-project-patterns into writing-plans per code-gen
  Task
  ([8a4a844](https://github.com/artk0de/TeaRAGs-MCP/commit/8a4a844ac31fbe18cc41c6675806827add5359ce))
- **tea-rags:** delegate DDG Step 2 TEMPLATE to extract-project-patterns
  ([4ac2b17](https://github.com/artk0de/TeaRAGs-MCP/commit/4ac2b17e514473f3ce0bf406f465a2d0d1860509))

### Documentation

- **ddg:** design spec for project-wide proven templates with locale fallback
  ([f782ddb](https://github.com/artk0de/TeaRAGs-MCP/commit/f782ddb63facdd7566f60481e317361a6afe3e40))
- **ddg:** fix gate expression mangled by markdownlint autofix
  ([5aea14f](https://github.com/artk0de/TeaRAGs-MCP/commit/5aea14f2a7d683ff1580e37bb03c6ba65adba436))
- **extract-project-patterns:** implementation plan with 5 tasks + beads sync
  ([6208b55](https://github.com/artk0de/TeaRAGs-MCP/commit/6208b558a52776ecb6061c2312d82a7fcb3b57dd))
- **extract-project-patterns:** rewrite spec — three-level locality cascade as
  agent-only recipe
  ([3499a15](https://github.com/artk0de/TeaRAGs-MCP/commit/3499a1523e67cd84d3b59ab786af63e6ba0e9e0e))
- **website:** tighten incremental indexing claim and claude-context row
  ([a747415](https://github.com/artk0de/TeaRAGs-MCP/commit/a74741551e28e04ea31a95bcb8287048cbdb0043))

## [1.26.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.25.1...v1.26.0) (2026-05-17)

### ⚠ BREAKING CHANGES

- **contracts:** External consumers typing against the global ErrorCode union
  must now import the per-domain unions (IngestErrorCode etc.) for strict
  typing. Loose string typing continues to work for runtime checks.

Co-Authored-By: Claude Opus 4.7 &lt;noreply@anthropic.com&gt;

### Features

- **chunker:** add TypeScript test-spec DSL chunking + orchestrator hook claim
  invariant
  ([e5e6880](https://github.com/artk0de/TeaRAGs-MCP/commit/e5e68808c8cee9328ba9baa44f836ffb8bdf001e))
- **skills:** add agent-invocable filter-building and analytics-rerank skills
  ([6d186ad](https://github.com/artk0de/TeaRAGs-MCP/commit/6d186ad889e8c3420be7307ecb1bade7d820c2e1))
- **tea-rags,dinopowers:** add tests-as-context skill + DSL test chunk
  integration
  ([644b1e3](https://github.com/artk0de/TeaRAGs-MCP/commit/644b1e30d558bdcf9cfb885c31ecd579035646f5))

### Bug Fixes

- **api:** make path optional in search_code + index_codebase; stabilize
  fs.watch flaky test
  ([b3a574b](https://github.com/artk0de/TeaRAGs-MCP/commit/b3a574b465632a461ad7fc93dd9fb3dc9c7b04f5))
- **hooks:** merge worktree-refactor-ingest-restructure pre-commit fix
  ([7b43908](https://github.com/artk0de/TeaRAGs-MCP/commit/7b43908083fe8772308207eadd5f8eb5650ee6fe))
- **hooks:** skip plugin-version-bump check on merge commits
  ([1529bb4](https://github.com/artk0de/TeaRAGs-MCP/commit/1529bb4c34459425fcc3d523620237fdffbe3ee5))
- **tea-rags:** spec-extraction recipe uses semantic_search not find_symbol
  ([aa44ab3](https://github.com/artk0de/TeaRAGs-MCP/commit/aa44ab3fea1196501bf042878d2f11b38ae0ae8c))
- **tests:** clear remaining 6 git-filter + limit drifts — all assertions green
  ([de7d255](https://github.com/artk0de/TeaRAGs-MCP/commit/de7d255de64c13cb99376feeacd6d96b8cc09ad1))
- **tests:** embedded Qdrant cascade + smoke-run drift fixes
  ([3d61840](https://github.com/artk0de/TeaRAGs-MCP/commit/3d61840ef7fbd51ff0bbba3f1ce887e05285cf63))

### Documentation

- **bench:** update spec-extraction recipe shape in summary table
  ([14d6b7e](https://github.com/artk0de/TeaRAGs-MCP/commit/14d6b7e323d881a05959c6d0f1a76998f7037d01))
- **chunker:** add TypeScript test DSL chunking design spec
  ([396c642](https://github.com/artk0de/TeaRAGs-MCP/commit/396c642f040eb12c937be6d0015be43738c03e55))
- **mcp:** expose hidden tea-rags functionality in tool descriptions, MCP
  resources, and search-cascade
  ([949f9d1](https://github.com/artk0de/TeaRAGs-MCP/commit/949f9d1124c0d4138253c2617375778f4e20c3f4))
- **plans:** archive ingest-restructure plan from completed refactor
  ([020e9a1](https://github.com/artk0de/TeaRAGs-MCP/commit/020e9a1b20d2446c4bf1c5b19cdc441ee0b3f1a2))
- **rules:** add silo-pairing process rule
  ([8064cd0](https://github.com/artk0de/TeaRAGs-MCP/commit/8064cd0bff6552bd9c2c5bcfd363b491e9228aac))
- **rules:** clarify subdomain import boundaries in barrel rule
  ([4058481](https://github.com/artk0de/TeaRAGs-MCP/commit/4058481305df26996689d4465225cd46fc027087))
- **rules:** document Stats vs Metrics taxonomy
  ([bfbc69f](https://github.com/artk0de/TeaRAGs-MCP/commit/bfbc69f2a68322738417f03900bff7c882c15976)),
  closes
  [IndexMetricsQuery#buildSignalMetrics](https://github.com/artk0de/IndexMetricsQuery/issues/buildSignalMetrics)
- **rules:** link silo-pairing.md from CLAUDE.md
  ([45c69c8](https://github.com/artk0de/TeaRAGs-MCP/commit/45c69c87500f7231c774dfef4b60600ee8cdd7a5))
- **rules:** mandatory subdomain barrels for ingest restructure
  ([2da2bb8](https://github.com/artk0de/TeaRAGs-MCP/commit/2da2bb80ee575219f0e9a2bbcbb08e86d8aea874))
- **rules:** require asking user to start ollama when embedding is down
  ([a3a962b](https://github.com/artk0de/TeaRAGs-MCP/commit/a3a962b915c6b74b021eb48493d1e3e32c2527c1))
- **superpowers:** add tech-debt Q2 2026 epic design
  ([68fd853](https://github.com/artk0de/TeaRAGs-MCP/commit/68fd853d6c6049a0013441779f1dc72ea19777ad))
- **superpowers:** add tech-debt Q2 2026 implementation plan
  ([b122c89](https://github.com/artk0de/TeaRAGs-MCP/commit/b122c89ee4f5c87f434dd033ff41ffc964c2b329))
- **website:** fix three rerank documentation drifts in api/tools.md
  ([ad88ffd](https://github.com/artk0de/TeaRAGs-MCP/commit/ad88ffda88debb6f83e4674a6e69a75b42c40eee))

### Code Refactoring

- **adapters:** extract InfraErrorCode local union
  ([06f0c6b](https://github.com/artk0de/TeaRAGs-MCP/commit/06f0c6b6a03cbe1098d6b0fce098bdfe108a1238))
- **api:** extract InputErrorCode local union from contracts
  ([6190ec2](https://github.com/artk0de/TeaRAGs-MCP/commit/6190ec2d12b777c36e0a80e596009c53d36b6579))
- **api:** extract wireFacades + wireOps from createApp
  ([9c67fd2](https://github.com/artk0de/TeaRAGs-MCP/commit/9c67fd2649097902b5488caef45a997d7f8f29fb))
- **config:** extract ConfigErrorCode local union
  ([6755193](https://github.com/artk0de/TeaRAGs-MCP/commit/6755193d6927311e88181d995abbf308a18874ed))
- **contracts:** collapse ErrorCode union to loose string contract
  ([9f016a8](https://github.com/artk0de/TeaRAGs-MCP/commit/9f016a8cfc1f2483e3dd221b31c25b3a69012dab))
- **explore:** extract ExploreErrorCode local union
  ([e3cab76](https://github.com/artk0de/TeaRAGs-MCP/commit/e3cab7650e5a26099458403c7ca5e885df99af8c))
- **ingest:** decompose reindexing block (158 -&gt; 3 phases)
  ([32a00ac](https://github.com/artk0de/TeaRAGs-MCP/commit/32a00ac9ea54b8269bc5a827a0a49a17c275430e))
- **ingest:** extract BatchDeleteExecutor from performDeletion
  ([19a4534](https://github.com/artk0de/TeaRAGs-MCP/commit/19a45349a9247bbce50021d9c1e4696c51488af4))
- **ingest:** extract DeletionRetryHelper from performDeletion
  ([922605b](https://github.com/artk0de/TeaRAGs-MCP/commit/922605b46aa2bbfeb6ff8e4a01432661f1ce0a5b))
- **ingest:** extract DeletionRetryHelper from performDeletion
  ([b769043](https://github.com/artk0de/TeaRAGs-MCP/commit/b769043b5ba14770349d9fb067de305897d9459d))
- **ingest:** extract HeartbeatGuard from IndexPipeline
  ([4283a5e](https://github.com/artk0de/TeaRAGs-MCP/commit/4283a5ecd7b649a44635a97d8e63e43094f5d0fb))
- **ingest:** extract IngestErrorCode local union, re-export from barrel
  ([add496c](https://github.com/artk0de/TeaRAGs-MCP/commit/add496ca07a5085f98a365bcb006af22acb5de28))
- **ingest:** extract MissedFileTracker from EnrichmentApplier
  ([9226cdf](https://github.com/artk0de/TeaRAGs-MCP/commit/9226cdf2f41eed3dc6dfe2903d6dd1097b838405))
- **ingest:** extract OptimizerLifecycle from IndexPipeline
  ([4362feb](https://github.com/artk0de/TeaRAGs-MCP/commit/4362feb278e2e6770d0e1eff3765d9d0e9458937))
- **ingest:** group cross-cutting helpers under infra/
  ([5d85893](https://github.com/artk0de/TeaRAGs-MCP/commit/5d85893fe0ff79d94e9b536b12fa5e86afdd7d5a))
- **ingest:** move IndexPipeline/ReindexPipeline into operations/
  ([5a1c2e5](https://github.com/artk0de/TeaRAGs-MCP/commit/5a1c2e526ec346a8f36fb28c154826e6d927a43a))
- **ingest:** move stats-recompute from explore to ingest
  ([b3f52b1](https://github.com/artk0de/TeaRAGs-MCP/commit/b3f52b1fd46d0807e6b80aebf4a1003a8176c45e))
- **ingest:** wire sync/ barrel + repoint ingest/ barrel to new paths
  ([d6f2f16](https://github.com/artk0de/TeaRAGs-MCP/commit/d6f2f1645485f0a0cc34eee2bca8e69b0d75a810))
- **mcp:** split registerCodeTools by tool family (326 -&gt; 5 modules)
  ([746e114](https://github.com/artk0de/TeaRAGs-MCP/commit/746e114135e4df1aaace1638f0080433cd38d4fa))
- **skills:** slim search-cascade, extract filter/analytics skills, eval
  coverage
  ([6598eac](https://github.com/artk0de/TeaRAGs-MCP/commit/6598eac2ab82d6065bb15785c2a862aac934a77e))
- **sync:** extract merkle + consistent-hash into sync/infra/
  ([db4fc9a](https://github.com/artk0de/TeaRAGs-MCP/commit/db4fc9af2e3f4153956739b059fc9a85d2875b33))
- **sync:** group snapshot persistence under sync/snapshot/
  ([035bcbf](https://github.com/artk0de/TeaRAGs-MCP/commit/035bcbf060cbc941a2588ece292b124b43540811))
- **sync:** split deletion cascade into sync/deletion/ with shorter names
  ([e7b85be](https://github.com/artk0de/TeaRAGs-MCP/commit/e7b85bef7bb4390e316d69fbff3fe036e5526de8))
- **tests:** post-SOLID integration test infrastructure
  ([0d47f9c](https://github.com/artk0de/TeaRAGs-MCP/commit/0d47f9c65d760d06049858741bee4fa96684dbb6))
- **tests:** remap easy integration suites to build/core paths
  ([00d071d](https://github.com/artk0de/TeaRAGs-MCP/commit/00d071d08e50e3eb40253662f04b723c74c17bcb))
- **tests:** rewrite chunk-A integration suites under IngestFacade/ExploreFacade
  ([69582a5](https://github.com/artk0de/TeaRAGs-MCP/commit/69582a5eb11ba5b56133d0e63bf82aaf0d809208))
- **tests:** rewrite chunk-B integration suites under IngestFacade/ExploreFacade
  ([82ddc59](https://github.com/artk0de/TeaRAGs-MCP/commit/82ddc5993919b53f8ec7bd2122370485e37c4ef1))
- **tests:** rewrite chunk-C integration suites under IngestFacade/ExploreFacade
  ([dfd6a25](https://github.com/artk0de/TeaRAGs-MCP/commit/dfd6a25a1a85064a87b7e80262a5607449cfe435))
- **tests:** rewrite chunk-D integration suites under IngestFacade/ExploreFacade
  ([625c8c3](https://github.com/artk0de/TeaRAGs-MCP/commit/625c8c396086b04fe282c01f2fe715dd4cc4f25a))
- **trajectory:** extract TrajectoryErrorCode local union
  ([9f2d401](https://github.com/artk0de/TeaRAGs-MCP/commit/9f2d4016c58ecd5df8bade4561d661ffa8267b0e))

## [1.25.1](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.25.0...v1.25.1) (2026-05-15)

### Bug Fixes

- **scripts:** escape curly braces in changelog for MDX safety
  ([41dad25](https://github.com/artk0de/TeaRAGs-MCP/commit/41dad257933e1156a732eb503df4a9722716bfac)),
  closes [#123](https://github.com/artk0de/TeaRAGs-MCP/issues/123)
  [#125](https://github.com/artk0de/TeaRAGs-MCP/issues/125)
- **website:** unbreak docs build after 1.25.0 release
  ([04d12e0](https://github.com/artk0de/TeaRAGs-MCP/commit/04d12e09a593f018297b985bd89ef4048a56aab6))

## [1.25.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.24.0...v1.25.0) (2026-05-15)

### ⚠ BREAKING CHANGES

- **explore:** Reranker.rerank() returns Promise. External callers must await.
  setCollectionStats accepts an optional opts arg with &#123; collectionName,
  payloadFieldKeys &#125; — wiring needed for lazy backfill persistence.
  setRecomputeService(service) is the new injection point; ExploreOps wires it
  before publishing stats.

Tests: rerank.test.ts (94 calls), rerank-rank-chunks-fixes.test.ts,
decomposition.test.ts updated to await + async it() callbacks. explore-facade
tests get setRecomputeService mock; post-process tests await the now-async free
function. 4300+ tests green.

Co-Authored-By: Claude Opus 4.7 &lt;noreply@anthropic.com&gt;

- **cli:** the standalone commands `tea-rags register-project`,
  `tea-rags list-projects`, and `tea-rags unregister-project` are removed. Use
  `tea-rags projects register`, `tea-rags projects list`, and
  `tea-rags projects unregister` instead.

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;

- **api:** resolveCollection(collection, path) signature removed; internal
  callers migrated. No public API impact (this function is internal to core/).

### Features

- **api:** add ProjectPathMissingError typed validation error
  ([f063c22](https://github.com/artk0de/TeaRAGs-MCP/commit/f063c22d2ef17fbc65426f739b72772172cfbc44)),
  closes [6/#7](https://github.com/6/TeaRAGs-MCP/issues/7)
- **api:** add ProjectRegistryOps for register/list/unregister
  ([47a0928](https://github.com/artk0de/TeaRAGs-MCP/commit/47a0928e9dd96512dbc6770cd0a7d06c28e9d9ef))
- **api:** add ProjectRegistryOps.recoverFromQdrant for doctor
  ([a8dd1f3](https://github.com/artk0de/TeaRAGs-MCP/commit/a8dd1f34776a58f00cb7d7809cbd136de8bb7fa1))
- **api:** add ProjectRegistryOps.recoverFromQdrant for doctor (impl + tests)
  ([4961ae7](https://github.com/artk0de/TeaRAGs-MCP/commit/4961ae7b905d2e2695c252b848c447449a795189))
- **api:** add projectSchema with regex validation to SchemaBuilder
  ([f2bf971](https://github.com/artk0de/TeaRAGs-MCP/commit/f2bf971cbbda5dc9b275dbf886d9bbb53d1f766c))
- **api:** expose registerProject/listProjects/unregisterProject on App
  ([8360d0f](https://github.com/artk0de/TeaRAGs-MCP/commit/8360d0f5d1afdf7ca4a491a522318a5885c046c1))
- **bootstrap:** start CollectionRegistry watcher for MCP server context
  ([7ea0793](https://github.com/artk0de/TeaRAGs-MCP/commit/7ea0793108b7dc025c1179493fde8340c2cd78b4)),
  closes [#2](https://github.com/artk0de/TeaRAGs-MCP/issues/2)
- **cli:** 'tea-rags projects unregister --purge' + verbose hint
  ([41960e2](https://github.com/artk0de/TeaRAGs-MCP/commit/41960e25ca267f842f4b8da69ca6bbc255fce79f)),
  closes [#8](https://github.com/artk0de/TeaRAGs-MCP/issues/8)
  [#12](https://github.com/artk0de/TeaRAGs-MCP/issues/12)
- **cli:** add --project option to tune command
  ([481d10f](https://github.com/artk0de/TeaRAGs-MCP/commit/481d10f61133114c230d3cb03e87fbf020ee22e5))
- **cli:** add 'tea-rags doctor' health summary
  ([bb7687d](https://github.com/artk0de/TeaRAGs-MCP/commit/bb7687d8f904ebb953d9f61e781a6e5136d86e81)),
  closes [6/#7](https://github.com/6/TeaRAGs-MCP/issues/7)
- **cli:** add 'tea-rags projects orphans' subcommand
  ([1823d77](https://github.com/artk0de/TeaRAGs-MCP/commit/1823d77ab2a5cba0f48a8bcc54e03ac5a5605247)),
  closes [#8](https://github.com/artk0de/TeaRAGs-MCP/issues/8)
- **cli:** add applyProjectDefaults helper for --project resolution
  ([07324bd](https://github.com/artk0de/TeaRAGs-MCP/commit/07324bd13828c7f61c3d588faf7870b984e876f3))
- **cli:** add register-project command
  ([8f9884b](https://github.com/artk0de/TeaRAGs-MCP/commit/8f9884bf24a1652d5e0d22f0e760c56ad2ea7f36))
- **cli:** add tab-completion for --project alias values (bash/zsh)
  ([4dd22f1](https://github.com/artk0de/TeaRAGs-MCP/commit/4dd22f13faa05327c02f61c2de1fdaa7f7fdea44))
- **cli:** auto-install fish completion via postinstall when fish is detected
  ([b622ba7](https://github.com/artk0de/TeaRAGs-MCP/commit/b622ba7e96e8f9f1a914cb8c1ae91f14caebf8a5))
- **cli:** register 'doctor' command in createCli
  ([70096c9](https://github.com/artk0de/TeaRAGs-MCP/commit/70096c979e800e6638a5d7773d8ac377359d3f7a)),
  closes [7/#8](https://github.com/7/TeaRAGs-MCP/issues/8)
- **cli:** replace flat project-\* commands with 'tea-rags projects [sub]' group
  ([e1078e8](https://github.com/artk0de/TeaRAGs-MCP/commit/e1078e8d0bf688e72c67a1f7ecedaba18ea9be02))
- **cli:** wire 'tea-rags doctor --recover-registry' to ProjectRegistryOps
  ([1f32ece](https://github.com/artk0de/TeaRAGs-MCP/commit/1f32ece31c5bd35abf55ed2d8215384d246a411f)),
  closes [#7](https://github.com/artk0de/TeaRAGs-MCP/issues/7)
- **contracts:** add SignalConfidence + ConfidenceClampRule types
  ([9a3cc8d](https://github.com/artk0de/TeaRAGs-MCP/commit/9a3cc8d9313e9902df96ac3faff9d9dc04aa471b))
- **contracts:** add typed errors for project registry validation
  ([6926b84](https://github.com/artk0de/TeaRAGs-MCP/commit/6926b84386ac9741470a069d0e9abd549dea14b4))
- **dto:** add CollectionIdentifier mixin with optional project field
  ([09d2e92](https://github.com/artk0de/TeaRAGs-MCP/commit/09d2e925fdf7e9ab9d451bf5b5f6d8d6faadf6c0))
- **explore:** confidence-aware label resolution
  ([0cbe54e](https://github.com/artk0de/TeaRAGs-MCP/commit/0cbe54e48491822ceb7a4968f35dec9415f6dd65))
- **explore:** lazy hot recompute for missing percentiles
  ([3e0a948](https://github.com/artk0de/TeaRAGs-MCP/commit/3e0a948063f3abeae4032d396450d0a690acd5ad))
- **explore:** plumb confidence context through reranker
  ([bc38780](https://github.com/artk0de/TeaRAGs-MCP/commit/bc3878073d4a3eec7437806dcd965373b28890a2))
- **mcp:** add list_projects tool
  ([dbf823e](https://github.com/artk0de/TeaRAGs-MCP/commit/dbf823ee53fae8e92d4e4affa2edfc607f94ccf6))
- **mcp:** add register_project tool
  ([65a42e6](https://github.com/artk0de/TeaRAGs-MCP/commit/65a42e60c1b75b6c26aa918667868c9ab2130d08))
- **mcp:** add unregister_project tool
  ([0c72652](https://github.com/artk0de/TeaRAGs-MCP/commit/0c7265291a1eff1df37fb4f597122ddc271cdc35))
- **mcp:** add unregister_project tool source
  ([d8c076f](https://github.com/artk0de/TeaRAGs-MCP/commit/d8c076fca216688d694364734c872fb38ee195d1))
- **mcp:** expose project parameter in project-aware tools
  ([482cbb3](https://github.com/artk0de/TeaRAGs-MCP/commit/482cbb337a9a4dcf9c41b8bc37a562feadbca7b4))
- **metrics:** percentilesToCompute + validateSignalDependencies +
  lazy-recompute spec
  ([c5cc24c](https://github.com/artk0de/TeaRAGs-MCP/commit/c5cc24c0963090b555d66293a30cfec9f2055bab))
- **registry:** add atomic registry file IO
  ([3011d57](https://github.com/artk0de/TeaRAGs-MCP/commit/3011d571ad777cad3606e3f717ba4b4a10d491be))
- **registry:** add CollectionRegistry class
  ([191b80d](https://github.com/artk0de/TeaRAGs-MCP/commit/191b80ddad331aa4ddbbaa5dc2fce8c90bc578dd))
- **registry:** add foundation types, errors, barrel for project registry
  ([ab59d9f](https://github.com/artk0de/TeaRAGs-MCP/commit/ab59d9f32c58765eabf33522e1d327ec731fba84))
- **registry:** add migration framework and corrupt-file backup
  ([1a316f9](https://github.com/artk0de/TeaRAGs-MCP/commit/1a316f9aac3d6199a0b8dcfae219088caa304aa9)),
  closes [#3](https://github.com/artk0de/TeaRAGs-MCP/issues/3)
  [#10](https://github.com/artk0de/TeaRAGs-MCP/issues/10)
- **registry:** add PROJECT_NAME_RE constant and RegistryConcurrencyError
  ([fa393f4](https://github.com/artk0de/TeaRAGs-MCP/commit/fa393f44e50424cd70de05e7dc851daf62cdcb8a)),
  closes [#9](https://github.com/artk0de/TeaRAGs-MCP/issues/9)
  [#1](https://github.com/artk0de/TeaRAGs-MCP/issues/1)
- **registry:** fs.watch-based cache invalidation in CollectionRegistry
  ([a8b4ad3](https://github.com/artk0de/TeaRAGs-MCP/commit/a8b4ad3e12f5e00f42d71edba3ea9bf52762942b))
- **registry:** reject malformed entries in CollectionRegistry.record()
  ([1da2aec](https://github.com/artk0de/TeaRAGs-MCP/commit/1da2aec53f384bfa3580c0aa1ea8339e808dc69a)),
  closes [#5](https://github.com/artk0de/TeaRAGs-MCP/issues/5)
- **signals:** bugFixRate opts in to unified confidence
  ([b6f12c1](https://github.com/artk0de/TeaRAGs-MCP/commit/b6f12c114ffbe18ae66303bfbebe674c6ce3c330))

### Improvements

- **agents:** forbid test buckets in coverage-expander
  ([9ea760c](https://github.com/artk0de/TeaRAGs-MCP/commit/9ea760cf43974974b929b88abc71a1c7823ab3ed)),
  closes [#5](https://github.com/artk0de/TeaRAGs-MCP/issues/5)
- **agents:** rewrite coverage-expander to use tea-rags + json coverage
  ([38afdbf](https://github.com/artk0de/TeaRAGs-MCP/commit/38afdbfa889c0f249d6a58c3e27254714b2cd2a1))
- **api:** drop fake new Date() stamp in tryEnrichFromQdrant
  ([37cd902](https://github.com/artk0de/TeaRAGs-MCP/commit/37cd902af9c613f72998626121d8c38d9156c08e)),
  closes [#14](https://github.com/artk0de/TeaRAGs-MCP/issues/14)
  [#5](https://github.com/artk0de/TeaRAGs-MCP/issues/5)
- **api:** register_project rename-only fast path skips Qdrant for populated
  entries
  ([76c5d38](https://github.com/artk0de/TeaRAGs-MCP/commit/76c5d38f64f5fc9461d7c5ac384aa7ca51458b2f))
- **cli:** 'projects info' surfaces realpath divergence and missing-on-disk
  ([1ba4c4c](https://github.com/artk0de/TeaRAGs-MCP/commit/1ba4c4cea1c5f676bd5e57df920f937d5556a067))
- **cli:** applyProjectDefaults throws typed errors and ignores empty-string
  registry stubs
  ([a285165](https://github.com/artk0de/TeaRAGs-MCP/commit/a285165d542ef8b2bbd4a6ac79816a74239544d0)),
  closes [#15](https://github.com/artk0de/TeaRAGs-MCP/issues/15)
- **cli:** tune handler catches InputValidationError from applyProjectDefaults
  ([86eaf03](https://github.com/artk0de/TeaRAGs-MCP/commit/86eaf0361038ac0ea1facd6fe1b6450d5ed74085)),
  closes [#15](https://github.com/artk0de/TeaRAGs-MCP/issues/15)
- **mcp:** mark project as RECOMMENDED in MCP tool descriptions
  ([1f8f5cc](https://github.com/artk0de/TeaRAGs-MCP/commit/1f8f5cc05d711dccb59afc4dd33b88ef36266b3e))
- **qdrant:** tune auto-spawns embedded daemon when no Qdrant URL given
  ([1b056ca](https://github.com/artk0de/TeaRAGs-MCP/commit/1b056ca48416f0728a5fc72a94105ff5402422fd))
- **rules:** document typed filters + MCP resource fetching in search-cascade
  ([ddbbdbd](https://github.com/artk0de/TeaRAGs-MCP/commit/ddbbdbd590b1cd445b0131089863bc3455fbdb54))
- **tea-rags:** index skill offers to register project after first-time index
  ([1f085af](https://github.com/artk0de/TeaRAGs-MCP/commit/1f085af200cc25aaa74e41ba7f284d2face58d6c))

### Bug Fixes

- **agents:** repair prettier-corrupted tea-rags tool names in coverage-expander
  ([695bbe1](https://github.com/artk0de/TeaRAGs-MCP/commit/695bbe14270dad1fd4ef1dfe86505826e52d3e98))
- **api:** register_project recovers teaRagsVersion + indexedAt from
  indexing-marker
  ([f2d9401](https://github.com/artk0de/TeaRAGs-MCP/commit/f2d9401107ffaa7374d1022b523fae998615cd32))
- **cli:** align 'doctor' orphan count with 'projects orphans' alias filter
  ([a5bf55a](https://github.com/artk0de/TeaRAGs-MCP/commit/a5bf55a5af100a052811b0c47de78311ea4b0004))
- **cli:** exclude aliased physical collections from 'projects orphans'
  ([a4621f9](https://github.com/artk0de/TeaRAGs-MCP/commit/a4621f91d1383df2e128e35467279a3b32475676))
- **cli:** per-option file completion for --path; suppress noise for --name
  register
  ([0e30ab4](https://github.com/artk0de/TeaRAGs-MCP/commit/0e30ab4e0f9f5bb1d2c9ac3fbe1ecd63a58d07b3))
- **cli:** tab-completion fires properly through yargs fallback-fn protocol
  ([53dfa61](https://github.com/artk0de/TeaRAGs-MCP/commit/53dfa61bbbc98817935d86723cd5bdcb0bf969a1))
- **explore:** siblingValues for confidence clamp come from raw payload
  ([5654101](https://github.com/artk0de/TeaRAGs-MCP/commit/56541018bcb3fddce1b4107191768b6edc22056a))
- **registry:** enrichment reads embeddingModel from indexing-marker, not random
  chunk
  ([91ae98c](https://github.com/artk0de/TeaRAGs-MCP/commit/91ae98c81ebd1a28055554a8f56e55347e777fc6))
- **registry:** merge-on-write with inode+mtime CAS in flush()
  ([02a1d40](https://github.com/artk0de/TeaRAGs-MCP/commit/02a1d4094098b3cd40c383c22cb5ab14fd9080f0)),
  closes [#1](https://github.com/artk0de/TeaRAGs-MCP/issues/1)
- **registry:** T4 review — rename PATH_NOT_EXISTS code, humanize invalid-name
  reason
  ([64102b9](https://github.com/artk0de/TeaRAGs-MCP/commit/64102b92878523c69f849cc325d7c7f38c237094))
- **registry:** watch dataDir instead of registry.json (fs.watch inode
  regression)
  ([b5fb94e](https://github.com/artk0de/TeaRAGs-MCP/commit/b5fb94ebcb9e86f9bc7ef799fe6891b74243f573)),
  closes [#2](https://github.com/artk0de/TeaRAGs-MCP/issues/2)
- **signals:** restore adaptive precedence for BugFixSignal dampening
  ([88a3534](https://github.com/artk0de/TeaRAGs-MCP/commit/88a3534bb296fb8a1b1ff9a21d15a7462e7bbfb3))
- **test:** T16 review — use .js extension for ESM import
  ([c41b127](https://github.com/artk0de/TeaRAGs-MCP/commit/c41b127411ee7030e3f798b465070a2e9ea9fc1a))

### Documentation

- **dinopowers:** wrappers prefer project alias over path in enrichment calls
  ([05b4803](https://github.com/artk0de/TeaRAGs-MCP/commit/05b480397284c914309ab36a70846ac2db61caad))
- document project registry MCP tools and CLI commands
  ([0588d78](https://github.com/artk0de/TeaRAGs-MCP/commit/0588d78aa6744e62ecb534f40a761141d6f10bfe))
- **plans:** add PR1 implementation plan for project registry hardening
  ([12c4c00](https://github.com/artk0de/TeaRAGs-MCP/commit/12c4c000cd63257194bdd8dec1c92c950f4dffe5)),
  closes [#1](https://github.com/artk0de/TeaRAGs-MCP/issues/1)
  [#2](https://github.com/artk0de/TeaRAGs-MCP/issues/2)
  [#3](https://github.com/artk0de/TeaRAGs-MCP/issues/3)
  [#4](https://github.com/artk0de/TeaRAGs-MCP/issues/4)
  [#9](https://github.com/artk0de/TeaRAGs-MCP/issues/9)
  [#10](https://github.com/artk0de/TeaRAGs-MCP/issues/10)
- **plans:** add PR2 implementation plan for project registry recovery + UX
  ([fab86ab](https://github.com/artk0de/TeaRAGs-MCP/commit/fab86abe50d54b58467f5137c1ba5c09876d1a80)),
  closes [#5](https://github.com/artk0de/TeaRAGs-MCP/issues/5)
  [#6](https://github.com/artk0de/TeaRAGs-MCP/issues/6)
  [#7](https://github.com/artk0de/TeaRAGs-MCP/issues/7)
  [#8](https://github.com/artk0de/TeaRAGs-MCP/issues/8)
  [#12](https://github.com/artk0de/TeaRAGs-MCP/issues/12)
- **plans:** add PR3 implementation plan for project registry polish
  ([a2fd2ae](https://github.com/artk0de/TeaRAGs-MCP/commit/a2fd2ae5469516bf3d69b31351c4b6c746bbc84b)),
  closes [#5](https://github.com/artk0de/TeaRAGs-MCP/issues/5)
  [#13](https://github.com/artk0de/TeaRAGs-MCP/issues/13)
  [#15](https://github.com/artk0de/TeaRAGs-MCP/issues/15)
- **plans:** add project registry implementation plan
  ([d9e4e0a](https://github.com/artk0de/TeaRAGs-MCP/commit/d9e4e0a493d8f5cb47c0d49533ce2ba172185cfb))
- **plans:** unified plan for hotspot signal interpretation rework
  ([8f3a9d0](https://github.com/artk0de/TeaRAGs-MCP/commit/8f3a9d0a08eaf811e67c267b517218e328c88f84))
- **presets:** align HotspotsPreset docstring with weights
  ([eb21700](https://github.com/artk0de/TeaRAGs-MCP/commit/eb21700b102e410f1634a0c7ebf38294b6f2837e))
- **registry:** clarify PROJECT_NAME_RE SoT scope and align barrel order
  ([4475aec](https://github.com/artk0de/TeaRAGs-MCP/commit/4475aec058e5a9068777cd6387f548a4095765df))
- **registry:** correct CAS worst-case comment +
  [@throws](https://github.com/throws) JSDoc + tombstone test
  ([264dc91](https://github.com/artk0de/TeaRAGs-MCP/commit/264dc910c56a82e7e8f1ecd32b0c46b59e1ef890)),
  closes [audit-#1](https://github.com/artk0de/audit-/issues/1)
- **registry:** document partial nature of registry/errors layer relocation
  ([01763f7](https://github.com/artk0de/TeaRAGs-MCP/commit/01763f752782c481746af56ccdeee493a811062f))
- **rules,website:** update confidence/label docs for adaptive thresholds +
  percentilesToCompute
  ([4ce41b3](https://github.com/artk0de/TeaRAGs-MCP/commit/4ce41b302cbc10a913a0674221119d4c5c31c56c))
- **rules,website:** update signal-confidence + reranking for lazy-at-rerank
  ([1a673fa](https://github.com/artk0de/TeaRAGs-MCP/commit/1a673faa08bdf3e855b578ff5f5fe506f9ef9308))
- **rules:** add npm link workflow for MCP integration testing in worktrees
  ([40b2179](https://github.com/artk0de/TeaRAGs-MCP/commit/40b2179ca976a2cf06e7aa41150b72ce8def4ed4))
- **rules:** add reindex / schema-drift guidance to MCP integration testing
  ([a664dc9](https://github.com/artk0de/TeaRAGs-MCP/commit/a664dc9d82c00bfa6bb435889ac7b5ee043d3302))
- **rules:** clarify npm link sequence — merge between worktree and main
  ([a7b7bff](https://github.com/artk0de/TeaRAGs-MCP/commit/a7b7bff4a3e78a9765ba7065f58498c2633357e2))
- **rules:** Fragile Silo pattern + small-N anti-pattern + recipe
  ([fe96954](https://github.com/artk0de/TeaRAGs-MCP/commit/fe96954405fb216dcbfd6757ffa353a857aebaca)),
  closes [#8](https://github.com/artk0de/TeaRAGs-MCP/issues/8)
- **rules:** how to use SignalConfidence in payload signal descriptors
  ([08a16a2](https://github.com/artk0de/TeaRAGs-MCP/commit/08a16a2b5c4786e44af353bbcc69726094641e05))
- **specs:** add project registry design (gr4o ∪ 2mrz)
  ([557bfe3](https://github.com/artk0de/TeaRAGs-MCP/commit/557bfe33a14757034f42fae3dd80e5e3252388e4))
- **specs:** add project registry hardening design
  ([bd78bd4](https://github.com/artk0de/TeaRAGs-MCP/commit/bd78bd462d173e4d60277976e538971522132915))
- **specs:** split hotspot/bug-prone signal interpretation into six per-problem
  specs
  ([86e4b23](https://github.com/artk0de/TeaRAGs-MCP/commit/86e4b231faac187199679f42dc2933399c749745)),
  closes [#8](https://github.com/artk0de/TeaRAGs-MCP/issues/8)
- **tea-rags:** teach search-cascade to prefer project alias over path
  ([698ccbb](https://github.com/artk0de/TeaRAGs-MCP/commit/698ccbb832ac54f2c66e124d5a12a9ab4438be63))
- **website:** add Project Registry pages
  ([267e1d2](https://github.com/artk0de/TeaRAGs-MCP/commit/267e1d2c531a0acc4527e7f85b75131e616636b4))
- **website:** document project registry doctor command, orphans, --purge, and
  new typed errors
  ([33c7bd5](https://github.com/artk0de/TeaRAGs-MCP/commit/33c7bd58b731292dba9d624c7a0e330285da55a6))
- **website:** drop lazy-backfill subsection from core-concepts/reranking
  ([287514f](https://github.com/artk0de/TeaRAGs-MCP/commit/287514f73e1660da0519f7c95a866b9298c8ee73))

### Code Refactoring

- **api:** resolveCollection accepts registry+project; plumb registry via DI
  ([05b59e3](https://github.com/artk0de/TeaRAGs-MCP/commit/05b59e3369cda7bb9a51e07dbdb224196d8b1e59))
- **explore:** move stats recompute from stats-load to rerank-time
  ([39ce11a](https://github.com/artk0de/TeaRAGs-MCP/commit/39ce11a1eb121db12003f66e9c13d20792b9e0e9))
- **registry:** introduce RegistryNameConflictError for infra-level conflict
  ([138cf7f](https://github.com/artk0de/TeaRAGs-MCP/commit/138cf7f546a1b39f04ec2c56747bceee4884e6df)),
  closes [#4](https://github.com/artk0de/TeaRAGs-MCP/issues/4)
- **registry:** relocate registry errors to adapters layer + barrel-import
  cleanup
  ([bb30458](https://github.com/artk0de/TeaRAGs-MCP/commit/bb304586d32f11398db5c70ce922ea6750317ff8))
- **registry:** route all PROJECT_NAME_RE callers to shared constant
  ([2cd113f](https://github.com/artk0de/TeaRAGs-MCP/commit/2cd113f6df7258dc0ffde7187f362ada679a0628)),
  closes [#9](https://github.com/artk0de/TeaRAGs-MCP/issues/9)
- **signals:** BugFixSignal reads dampening from descriptor
  ([4ea7d27](https://github.com/artk0de/TeaRAGs-MCP/commit/4ea7d279eb5cfe8b45cca0070be430d01a4d1ec5))
- **signals:** migrate 6 remaining derived signals to unified confidence +
  adaptive labels
  ([654b838](https://github.com/artk0de/TeaRAGs-MCP/commit/654b83856799d98e71024503263a3e039a5ca45f))

## Unreleased

### Features

- **registry:** project registry (`registry.json`) — auto-populated collection
  metadata + named project bindings.
  - New MCP tools: `register_project`, `list_projects`, `unregister_project`.
  - New CLI commands: `register-project`, `list-projects`, `unregister-project`.
  - All project-aware tools and commands accept an optional `project` parameter
    (resolution priority: `collection &gt; project &gt; path`).
  - `BaseIndexingPipeline.finalizeProcessing` records collection metadata to the
    registry after Qdrant writes complete.
  - `ProjectRegistryOps.recoverFromQdrant` for future doctor usage.

## [1.23.2](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.23.1...v1.23.2) (2026-05-08)

### Bug Fixes

- **enrichment:** FIFO serialize concurrent prefetch in EnrichmentCoordinator
  ([5943a87](https://github.com/artk0de/TeaRAGs-MCP/commit/5943a872b2f7e79767c2b5e3c772c4469ddde8ee)),
  closes [#2](https://github.com/artk0de/TeaRAGs-MCP/issues/2)
- **enrichment:** per-run RunState container in EnrichmentCoordinator
  ([b8bb167](https://github.com/artk0de/TeaRAGs-MCP/commit/b8bb16734f568e20ea465b76138010f60fb86216)),
  closes [#1](https://github.com/artk0de/TeaRAGs-MCP/issues/1)
- **stats:** re-fire onChunkEnrichmentComplete after backfill
  ([8e40ed8](https://github.com/artk0de/TeaRAGs-MCP/commit/8e40ed8ccabbed7ffd967636cbeddb307fa494a3))

### Documentation

- **plans:** enrichment RunState — implementation plan
  ([2d1e6e9](https://github.com/artk0de/TeaRAGs-MCP/commit/2d1e6e96ca20837b1312c3908ec082b97244cff2))
- **specs:** enrichment RunState — per-run state container
  ([d11fa3c](https://github.com/artk0de/TeaRAGs-MCP/commit/d11fa3cd725b245a5c51297448030afbfdbf98eb)),
  closes [#1](https://github.com/artk0de/TeaRAGs-MCP/issues/1)
  [#2](https://github.com/artk0de/TeaRAGs-MCP/issues/2)

## [1.23.1](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.23.0...v1.23.1) (2026-05-07)

### Bug Fixes

- **plugin:** drop type:mcp_tool hooks — Opus 4.7 timing makes them unusable
  ([72fdd2b](https://github.com/artk0de/TeaRAGs-MCP/commit/72fdd2bf6968968c2b0fdd0dd87f8f4d13405bdc))

## [1.23.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.22.0...v1.23.0) (2026-05-07)

### ⚠ BREAKING CHANGES

- **stats:** STATS_ACCUMULATOR_KEYS.AUTHOR_COUNTS / LINE_AUTHOR_COUNTS keys were
  renamed to RECENT_AUTHOR_COUNTS / BLAME_AUTHOR_COUNTS. Any external code
  referencing the old keys must be updated. Distributions DTO gains a new
  required field topBlameAuthors.

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;

- **presets:** proven preset ranking shifts. Files where ownership and
  knowledgeSilo disagreed (concentrated author share with ≥3 contributors) no
  longer get penalized. Stable preset top-N also moves slightly.

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;

- **signals:** payload field renames break existing search queries that filter
  by `git.file.dominantAuthor`, `git.file.authors`, `git.file.contributorCount`,
  or `git.chunk.contributorCount`. Schema migration applies on next
  index_codebase run; agents/skills must update to the new field names. Filter
  params `author` and `lineOwner` removed; use `recentAuthor` and `blameOwner`.

Refs spec 2026-05-06-line-based-ownership-from-blame.md (Task 7.5).

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;

- **signals:** rerank: "ownership" returns different top-N than before. Files
  written long ago by a now-departed author who still owns the live lines now
  rank as silos correctly; files only recently fix-touched no longer falsely
  register as concentrated. Plugin heuristics that read raw ownership values
  must reindex with forceReindex=true to populate lineDominantAuthor\* fields.

Refs spec 2026-05-06-line-based-ownership-from-blame.md (Task 5).

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;

### Features

- **api:** expose line-based ownership in filters, stats, MCP schemas
  ([eb6649a](https://github.com/artk0de/TeaRAGs-MCP/commit/eb6649af5f3a4f5b5a57c34b16c6b56685986a08))
- **filters:** name-or-email author match + recent-contributor range
  ([75b1ecb](https://github.com/artk0de/TeaRAGs-MCP/commit/75b1ecb6525bddd13f4dc48c2015c6ecdf62f0c4))
- **git:** add blame primitive for line-based ownership
  ([807b78b](https://github.com/artk0de/TeaRAGs-MCP/commit/807b78bc8b1bc959c306d8085f9f6d783f49a115))
- **plugin:** auto-fire session start protocol via mcp_tool hooks
  ([ecbbcd1](https://github.com/artk0de/TeaRAGs-MCP/commit/ecbbcd1fa4e7402a6fbb4684434c03a3f84d8b75)),
  closes [#26112](https://github.com/artk0de/TeaRAGs-MCP/issues/26112)
- **presets:** add line-based ownership to overlays +
  recentActivityConcentration weight
  ([68b4aa2](https://github.com/artk0de/TeaRAGs-MCP/commit/68b4aa27376a0925edce4b5ce2fa4166c33e7327))
- **signals:** add blame ownership extractor for line-based signals
  ([3d4bd1b](https://github.com/artk0de/TeaRAGs-MCP/commit/3d4bd1b1059382eafb37594811a7cacdb2698d44))
- **signals:** add line-based ownership payload schema
  ([45f12cf](https://github.com/artk0de/TeaRAGs-MCP/commit/45f12cf24f656fe36acb3a44e346efed455c9986))
- **signals:** reorient ownership/knowledgeSilo to live-line authorship
  ([d2ea7cc](https://github.com/artk0de/TeaRAGs-MCP/commit/d2ea7cc436a6588ca055c99c78f3c886f3d914b9))
- **signals:** wire blame ownership into chunk-level overlays
  ([2d3f844](https://github.com/artk0de/TeaRAGs-MCP/commit/2d3f8445853223ab0c10a55524694e9da4f2bc6d))
- **signals:** wire git blame into file-level ownership signals
  ([b639eaf](https://github.com/artk0de/TeaRAGs-MCP/commit/b639eaff600a0d0c748b9164d5cd58c37fb6a7b6))

### Improvements

- **dinopowers:** chain executing-plans into tea-rags:data-driven-generation for
  code-gen Tasks
  ([48f090b](https://github.com/artk0de/TeaRAGs-MCP/commit/48f090b4528d1ef949342b139f7f16e7c9402d15))
- **presets:** knowledgeSilo for proven, drop ownership from stable
  ([9970121](https://github.com/artk0de/TeaRAGs-MCP/commit/9970121053885bb3b582655434ac657594a3280f))

### Bug Fixes

- **enrichment:** chunk-level backfill + surface marker write failures
  ([03faeb4](https://github.com/artk0de/TeaRAGs-MCP/commit/03faeb4762b18fe825eb59f2a0b7bd3cb46310ca))
- **enrichment:** re-poll unenriched count after grace period for marker
  ([d940199](https://github.com/artk0de/TeaRAGs-MCP/commit/d940199e9ce4c5657499d4ce44a1b12fcbf03859))
- **enrichment:** use scoped key for backfill writes (clobber prevention)
  ([449fed2](https://github.com/artk0de/TeaRAGs-MCP/commit/449fed2f5d1a0fdb759282b3d918f0ce717cb74a))
- **enrichment:** wait for streaming work before firing
  onChunkEnrichmentComplete
  ([fe7e457](https://github.com/artk0de/TeaRAGs-MCP/commit/fe7e45726daf05cf84ea00fd71d84bb44c01bbe4))
- **migration:** write nested git.\* keys instead of flat dot-keys in V13
  ([2a625cc](https://github.com/artk0de/TeaRAGs-MCP/commit/2a625ccc4513384dabb9eca59dcbaad35f11162a))
- **rules:** correct duplicate step 3 numbering in Session Start section
  ([024657d](https://github.com/artk0de/TeaRAGs-MCP/commit/024657d2a46e8e4cb6a2bcc3cd1a62a7f476626a))
- **signals:** accumulate blameByRelPath across batched buildFileSignals calls
  ([fdd2adf](https://github.com/artk0de/TeaRAGs-MCP/commit/fdd2adf2a54ed923d57109fce05ee18395ffa193))
- **signals:** process single-chunk files through chunk-level pipeline
  ([73b7341](https://github.com/artk0de/TeaRAGs-MCP/commit/73b73415f9bace7a23e7bf33f5814fccdd1be095))
- **stats:** write enrichment stats under public alias + clarify author taxonomy
  ([6ae9d83](https://github.com/artk0de/TeaRAGs-MCP/commit/6ae9d832d9c433204dd8dc4334dd5a93ef8dacd0))

### Documentation

- **dinopowers,tea-rags:** switch plugin skills to recent*/blame* ownership
  split
  ([1fac677](https://github.com/artk0de/TeaRAGs-MCP/commit/1fac6778cdd2a84a462b720b68540da69cc0e565))
- **plan:** add enrichment-coordinator split implementation plan
  ([90d4375](https://github.com/artk0de/TeaRAGs-MCP/commit/90d43756ea0f449a1d04f7bf447396819f0b9df9))
- **rules:** add end-to-end verification and nested-write guidance for
  migrations
  ([0400cd1](https://github.com/artk0de/TeaRAGs-MCP/commit/0400cd119945633a3020cccd0f2ca9c7ea3b7c47))
- **spec:** add enrichment-coordinator split design
  ([7d272c6](https://github.com/artk0de/TeaRAGs-MCP/commit/7d272c632a4d4b41ac231ae039d21e3026ef6305))
- **specs:** add codegraph symbols sub-trajectory vertical slice 1 design
  ([391fb49](https://github.com/artk0de/TeaRAGs-MCP/commit/391fb4930251e8e0e70890b5d54c3df5d2245760))
- **website,rules:** document recent*/blame* ownership split
  ([8ab19c2](https://github.com/artk0de/TeaRAGs-MCP/commit/8ab19c2bd2262305cc74eee588607941d536ccb6)),
  closes [#6](https://github.com/artk0de/TeaRAGs-MCP/issues/6)

### Code Refactoring

- **enrichment:** coordinator finalization + barrel cleanup
  ([1059748](https://github.com/artk0de/TeaRAGs-MCP/commit/10597481f04d8b7fdfb5744328489590aa7caa7c))
- **enrichment:** extract ChunkPhase with shared Semaphore + streaming dedup
  ([3e6574c](https://github.com/artk0de/TeaRAGs-MCP/commit/3e6574cd56fbf7b95d9fa966cf13a01420900b4f))
- **enrichment:** extract CompletionRunner with explicit 7-step run
  ([1a7489c](https://github.com/artk0de/TeaRAGs-MCP/commit/1a7489ce059fa3abb445d9f2ad44c3a96b3af44b))
- **enrichment:** extract EnrichmentBackfiller; narrow applier accessors
  ([5c21270](https://github.com/artk0de/TeaRAGs-MCP/commit/5c21270cd493c4f47eb988518d98819fb849e13e))
- **enrichment:** extract EnrichmentMarkerStore from coordinator
  ([ca3f3c0](https://github.com/artk0de/TeaRAGs-MCP/commit/ca3f3c02aeb74b222c2b6ba5c427176edbe8e16f))
- **enrichment:** extract FilePhase with prefetch + per-batch apply
  ([1ca1899](https://github.com/artk0de/TeaRAGs-MCP/commit/1ca1899a6a53f2dcbc82a75209cd9f76edf45e37))
- **enrichment:** introduce ProviderContext type computed in prefetch
  ([575beff](https://github.com/artk0de/TeaRAGs-MCP/commit/575beff6383e540ed0b984378d55810abe60f0cb))
- **enrichment:** move runRecovery race-guard into EnrichmentRecovery.recoverAll
  ([db36cab](https://github.com/artk0de/TeaRAGs-MCP/commit/db36cab0a324307bafe69ef2fddc19633eb256d0))
- **signals:** rename ownership payload fields with semantic prefixes
  ([85e4916](https://github.com/artk0de/TeaRAGs-MCP/commit/85e4916f9154c5698fa305ae89bf75e9b4d1851d))

## [1.22.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.21.0...v1.22.0) (2026-05-05)

### ⚠ BREAKING CHANGES

- **dinopowers:** New UserPromptSubmit hook injects routing context into every
  user prompt in projects with the dinopowers plugin enabled. Users who don't
  want this can disable the plugin or comment out the hook in plugin.json.

Benchmark: .claude-plugin/.benchmarks/dinopowers-wrappers/benchmark.md

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;

### Features

- **dinopowers:** rewrite descriptions, add main-session hook, override
  CLAUDE.md naming
  ([783377c](https://github.com/artk0de/TeaRAGs-MCP/commit/783377c61474ba5d9f4140846d77db8f547ce2dd))

### Bug Fixes

- **chunker:** enforce hard cap on chunk size to prevent Ollama context overflow
  ([3797b04](https://github.com/artk0de/TeaRAGs-MCP/commit/3797b0434e24a7f84a70e8ed9c01ba1ce16bb1bc)),
  closes [symbolId#partN](https://github.com/artk0de/symbolId/issues/partN)
- **ingest:** apply context safety factor even when user sets chunkSize
  ([dd76155](https://github.com/artk0de/TeaRAGs-MCP/commit/dd76155a44ca0e4813618a8376e39c69f5f38677))

### Code Refactoring

- **ingest:** split file/chunk marker writes in awaitCompletion
  ([aeb992d](https://github.com/artk0de/TeaRAGs-MCP/commit/aeb992d0b3afc30a60abd9309245ddeda474868b))

## [1.21.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.20.0...v1.21.0) (2026-04-24)

### ⚠ BREAKING CHANGES

- **qdrant:** QdrantManager constructor 4th parameter changed from
  `isStarting?: () =&gt; boolean` to `daemon?: EmbeddedDaemonProbe`. Internal API
  only - no public DTO change.

### Features

- **adapters:** add QdrantOptimizationInProgressError
  ([2b219d7](https://github.com/artk0de/TeaRAGs-MCP/commit/2b219d7ebfa5d549676e64f02b961780e86ea4b8))
- **adapters:** expose Qdrant status and optimizerStatus in getCollectionInfo
  ([a4df5a7](https://github.com/artk0de/TeaRAGs-MCP/commit/a4df5a7ffa9ef402b2c81e0a972ae06b07300265))
- **adapters:** probe collection status on countPoints failure
  ([ecdccc3](https://github.com/artk0de/TeaRAGs-MCP/commit/ecdccc3706c253ea49805da4746677d8bd4dafec))
- **config:** embedded-aware delete tuning defaults
  ([c3960b8](https://github.com/artk0de/TeaRAGs-MCP/commit/c3960b80cc287f27c4f9d634c2cc55a475b953ec))
- **config:** introduce .qdrant-required-version + rename to
  EMBEDDED_QDRANT_VERSION
  ([0b5cc18](https://github.com/artk0de/TeaRAGs-MCP/commit/0b5cc180e7ea5dc661f1c8fabfa0be31c6f109dc))
- **contracts:** add ChunkSignalOptions with external semaphore support
  ([94be2e4](https://github.com/artk0de/TeaRAGs-MCP/commit/94be2e4aa946e52a73cefcb13d087aea6f0e4375))
- **contracts:** add status and optimizerStatus to CollectionInfo DTO
  ([db74c1e](https://github.com/artk0de/TeaRAGs-MCP/commit/db74c1e23a97532cf7870bbcec6ac07e0e44e16f))
- **contracts:** surface Qdrant collection status in IndexStatus.infraHealth
  ([86c5153](https://github.com/artk0de/TeaRAGs-MCP/commit/86c5153eacd6e6a14d7065126b2ae5b51f81b798))
- **infra:** add async Semaphore for bounded concurrency
  ([1964e2c](https://github.com/artk0de/TeaRAGs-MCP/commit/1964e2cd1bcf80c6350a8dccba2514e0b3c4e2aa))
- **ingest:** DeletionOutcome tracks per-path delete success
  ([b842029](https://github.com/artk0de/TeaRAGs-MCP/commit/b8420294820ed62492f117de4d6cb2937c43df39))
- **ingest:** ReindexCoordinator gates upsert on delete success per file
  ([5896815](https://github.com/artk0de/TeaRAGs-MCP/commit/5896815a5a15d5cc5afa4370e653e4bc9a442445))
- **ingest:** use cached pointsCount for deletion delta reporting
  ([7fe52a7](https://github.com/artk0de/TeaRAGs-MCP/commit/7fe52a7f264ad819072c4a0fee2e6c7778f04c2b))
- **pipeline:** AdaptiveBatchSizer halves upsert batch on Qdrant yellow
  ([2fa202f](https://github.com/artk0de/TeaRAGs-MCP/commit/2fa202f15fe0e31c2ce26a8c70fbcac942175e1a))
- **pipeline:** ChunkPipeline reduces upsert batch size on Qdrant yellow
  ([d8a27ca](https://github.com/artk0de/TeaRAGs-MCP/commit/d8a27ca4700d205a1916e0dc3cc3b3291bcd9984))
- **pipeline:** per-file FILE_INGESTED telemetry with top-N slow-file tracker
  ([0a393f1](https://github.com/artk0de/TeaRAGs-MCP/commit/0a393f1955eb2b33e500d98921393d08cab1ff86))
- **pipeline:** register schema v12 in SchemaMigrator
  ([51f7c50](https://github.com/artk0de/TeaRAGs-MCP/commit/51f7c50ed3c374d91b4b6f69a652dc4bf887974c))
- **pipeline:** schema v12 migration adds enrichment payload indexes
  ([3bc3d36](https://github.com/artk0de/TeaRAGs-MCP/commit/3bc3d366563bc5f6777c9dae4d0202f91a551d18))
- **pipeline:** streaming chunk enrichment per-batch in coordinator
  ([9012768](https://github.com/artk0de/TeaRAGs-MCP/commit/9012768136fb00f45788bb3f9c1027bb6257d4c7))
- **qdrant:** enable multi-core defaults for embedded daemon
  ([66adad5](https://github.com/artk0de/TeaRAGs-MCP/commit/66adad52c72d0585d1ac5b531bd5e3ebb07a87b3))
- **qdrant:** split embedded daemon startup errors, non-blocking spawn
  ([146ec62](https://github.com/artk0de/TeaRAGs-MCP/commit/146ec623fdb7ced7df743ec139af5dddd06e0baf))
- **qdrant:** unify version constant, add external check and downgrade guard
  ([3978b8e](https://github.com/artk0de/TeaRAGs-MCP/commit/3978b8e1e04da3b69428e18df4deeacec5aa26b4))
- **signals:** add pair diagnostics layer for architectural interpretation
  ([5f92166](https://github.com/artk0de/TeaRAGs-MCP/commit/5f92166f5db2e0035b44a10dae0ac764b40e2295))

### Bug Fixes

- **explore:** symmetrize find_symbol payload contract with semantic/hybrid
  ([dc1a2a1](https://github.com/artk0de/TeaRAGs-MCP/commit/dc1a2a11d2088fc6b38ec342a0b008d4cda2ce75))
- **ingest:** gate modified-file upsert on delete success per file
  ([7fe355d](https://github.com/artk0de/TeaRAGs-MCP/commit/7fe355d8bf3e236a1779fd40864e617ace454a00))
- **ingest:** prevent stale enrichment marker overwriting current run
  ([b09bcd1](https://github.com/artk0de/TeaRAGs-MCP/commit/b09bcd19bb8426c54bc2b505c75d24d5f8821d6a))
- **ingest:** recover stale enrichment.in_progress at health-mapper read
  ([600744d](https://github.com/artk0de/TeaRAGs-MCP/commit/600744de4397fe692ecb924e6018b24e547b8329))
- **ingest:** run enrichment recovery even on reindex with 0 changes
  ([9fa596d](https://github.com/artk0de/TeaRAGs-MCP/commit/9fa596d140bea852eff23e1c9bc56b0368ee9f5f))
- **ingest:** stamp chunk-level enrichedAt for missed files, sync marker with
  real count
  ([d74b09a](https://github.com/artk0de/TeaRAGs-MCP/commit/d74b09a74148a1a962eb1443d69b6054c76fae47))
- **ingest:** surface per-path delete failures via DeletionOutcome
  ([1a07d70](https://github.com/artk0de/TeaRAGs-MCP/commit/1a07d70d1743c5ab3d67c5c7231d7d6a230aade9))
- **pipeline:** getIndexStatus reads from alias, not orphan \_v(N+1)
  ([3311406](https://github.com/artk0de/TeaRAGs-MCP/commit/33114062e2783303ffc44972363207108363f426))

### Performance Improvements

- **qdrant:** scroll+delete-by-IDs and optimizer pause for large-delta reindex
  ([6220f86](https://github.com/artk0de/TeaRAGs-MCP/commit/6220f8631c77933fb2a6400c83b0de9db7331204))

### Documentation

- **specs:** add sub-collections cold memory design spec
  ([4aaa873](https://github.com/artk0de/TeaRAGs-MCP/commit/4aaa87376c91eecc6fb1cd3184d09e67f86d001d))
- **specs:** implementation plans for reindex resilience and yellow handling
  ([f3b43c2](https://github.com/artk0de/TeaRAGs-MCP/commit/f3b43c2b72cc736ea447d6ea161b44ded437b8ac))
- **specs:** qdrant yellow-status handling design
  ([7f75745](https://github.com/artk0de/TeaRAGs-MCP/commit/7f75745c12ec3971119ce0e237ee38bb818515a1))

### Code Refactoring

- **pipeline:** fix FILE_INGESTED type cast and hoist bytes computation
  ([60fe61f](https://github.com/artk0de/TeaRAGs-MCP/commit/60fe61ffc161b9936e38733f03fa580423c73753))

## [1.20.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.19.1...v1.20.0) (2026-04-22)

### ⚠ BREAKING CHANGES

- **config:** TRAJECTORY_GIT_ENABLED default changed from false to true. Users
  who previously relied on the absent-env-var meaning "disabled" must now set
  TRAJECTORY_GIT_ENABLED=false (or CODE_ENABLE_GIT_METADATA=false) to opt out.
  No action needed for users already setting the variable explicitly, or for
  non-git directories (silently skipped either way).

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;

### Features

- **dinopowers:** add brainstorming wrapper with 3-preset risk enrichment
  ([9eb9054](https://github.com/artk0de/TeaRAGs-MCP/commit/9eb9054c7e88a305d9aba500d154fe2e7896e8fc))
- **dinopowers:** add executing-plans wrapper with per-Task pre-touch guard
  ([c28b28b](https://github.com/artk0de/TeaRAGs-MCP/commit/c28b28b6c2ce8c3f7c78ac2a6b1be91cb2d267d5))
- **dinopowers:** add finishing-a-development-branch wrapper with branch-wide
  risk scan
  ([b5ccf04](https://github.com/artk0de/TeaRAGs-MCP/commit/b5ccf04c3603e955396a9912978d171e36f8f4d2))
- **dinopowers:** add receiving-code-review wrapper with impact-verdict ladder
  ([b770086](https://github.com/artk0de/TeaRAGs-MCP/commit/b7700866f7c1f97c5049ec2c49041d503fe538ae))
- **dinopowers:** add requesting-code-review wrapper with reviewer-context
  bundle
  ([4308ecc](https://github.com/artk0de/TeaRAGs-MCP/commit/4308eccdf934695fbd216606e16e1a79ff1befd6))
- **dinopowers:** add subagent routing hook, README, versioning rule entry
  ([a3ae389](https://github.com/artk0de/TeaRAGs-MCP/commit/a3ae38982d15d04042886d6b07d4db3e0386aabd))
- **dinopowers:** add systematic-debugging wrapper composing with
  tea-rags:bug-hunt
  ([4fd8dd9](https://github.com/artk0de/TeaRAGs-MCP/commit/4fd8dd99f67fdc6b1a2d33f3758b7da9cc4215bf))
- **dinopowers:** add test-driven-development wrapper with proven-test pattern
  search
  ([c60129e](https://github.com/artk0de/TeaRAGs-MCP/commit/c60129e6d3a70c1372f7b871d9aeb7cc2805778a))
- **dinopowers:** add verification-before-completion wrapper with
  collateral-damage scan
  ([0167524](https://github.com/artk0de/TeaRAGs-MCP/commit/0167524330fe93e53b42641dce9ee37043a0b686))
- **dinopowers:** add writing-plans wrapper with per-file impact enrichment
  ([22f675f](https://github.com/artk0de/TeaRAGs-MCP/commit/22f675f6164c6c44dfd7cdd688e0ac4e1b6680aa))
- **dinopowers:** scaffold plugin and add writing-skills bootstrap wrapper
  ([52660b7](https://github.com/artk0de/TeaRAGs-MCP/commit/52660b708e89962879386522481b1a1748e3f928))

### Improvements

- **config:** enable git trajectory enrichment by default
  ([f0a9e17](https://github.com/artk0de/TeaRAGs-MCP/commit/f0a9e17ab7183a3c19607354dd8e07529cf75f4b))

### Bug Fixes

- **dinopowers:** redirect inner superpowers:Y chain-hops to dinopowers:Y
  wrappers
  ([6d8f78f](https://github.com/artk0de/TeaRAGs-MCP/commit/6d8f78f3851a40513e15d99a1fbc29f81572b503))
- **embedding:** detect primary Ollama death mid-session via background probe
  ([dd4e1f0](https://github.com/artk0de/TeaRAGs-MCP/commit/dd4e1f03be16bde9bc5947be97cba1917d60c8d6))
- **setup:** correct Node version, use global tea-rags binary, auto-install
  Ollama on macOS
  ([98e61cc](https://github.com/artk0de/TeaRAGs-MCP/commit/98e61cc1f4a33d5a60a5bccc2b08df825fb33687))

### Documentation

- add specs and plans for 3 hygiene refactorings
  ([f2bac4b](https://github.com/artk0de/TeaRAGs-MCP/commit/f2bac4b4e6919579d59251c9569bdf98f13b32fb))
- document dinopowers plugin in skills page and main README
  ([b03ae0b](https://github.com/artk0de/TeaRAGs-MCP/commit/b03ae0b0cefbb330dc60fe953e5aa428058815be))
- **explore:** plan for Reranker.rerank() phase extraction
  ([8a73803](https://github.com/artk0de/TeaRAGs-MCP/commit/8a738033fada7d86cc06352f87930719d9d55142))
- **explore:** spec for Reranker.rerank() phase extraction
  ([a44741a](https://github.com/artk0de/TeaRAGs-MCP/commit/a44741aae75774b7a8e5b0254bdf4bb6cfc2b20b))
- fix superpowers attribution (obra/superpowers, not anthropic/skills)
  ([db25657](https://github.com/artk0de/TeaRAGs-MCP/commit/db25657a9e246f5e8bea90ba9feca9f9df00dc87))
- **readme+website:** fix "not for solo projects" — document GIT SESSIONS mode
  ([906b308](https://github.com/artk0de/TeaRAGs-MCP/commit/906b308d4575a94b477e316f41f7d08a4303483b)),
  closes
  [#git-sessions](https://github.com/artk0de/TeaRAGs-MCP/issues/git-sessions)
- **readme:** align README with landing page, drop docker/npm clone, add plugin
  install
  ([c2b366d](https://github.com/artk0de/TeaRAGs-MCP/commit/c2b366d57b7af15274f18de7b96e1e5d7e061ceb))
- **website:** fill priority empty sections + mermaid fix
  ([00c24c0](https://github.com/artk0de/TeaRAGs-MCP/commit/00c24c01e759f2b05e0200531be4dbaf737bd000))
- **website:** fill remaining extending + knowledge-base stubs
  ([fdda285](https://github.com/artk0de/TeaRAGs-MCP/commit/fdda2859bf56b88976e249f9d143f36256b288c4))
- **website:** fill roadmap sections from beads epics
  ([22934cc](https://github.com/artk0de/TeaRAGs-MCP/commit/22934cc467e76aca6e88e51fedaa6dd0628716a3))
- **website:** invert quickstart flow, fix claude mcp add syntax
  ([028cf04](https://github.com/artk0de/TeaRAGs-MCP/commit/028cf042ae41ae60e9ffd04fa1184a4a0b4e1232))
- **website:** plugin-first quickstart with manual install fallback
  ([3c25dc6](https://github.com/artk0de/TeaRAGs-MCP/commit/3c25dc6eb14885a7a175b2d79b74b5682313b76d))
- **website:** restructure usage/, rewrite landing, fix concept drift
  ([3e78a34](https://github.com/artk0de/TeaRAGs-MCP/commit/3e78a346d355f56e6f693b2f90e0584715794c19))
- **website:** sync api/config/architecture/agent-integration with current
  signals and env vars
  ([4a38f03](https://github.com/artk0de/TeaRAGs-MCP/commit/4a38f0394be90e8d105bbaff8d81b17c1e1a7d11)),
  closes [#9](https://github.com/artk0de/TeaRAGs-MCP/issues/9)

### Code Refactoring

- **bootstrap:** extract resolveInfrastructure + wireComposition from
  createAppContext
  ([0fb5772](https://github.com/artk0de/TeaRAGs-MCP/commit/0fb57720349bbeb06baab9c1be3b453f29ca7fe4))
- **chunker:** extract phase methods from
  MarkdownChunker[#chunk](https://github.com/artk0de/TeaRAGs-MCP/issues/chunk)
  ([2ecfc73](https://github.com/artk0de/TeaRAGs-MCP/commit/2ecfc7351c0432192dd075a2182bee6352ec155d))
- **explore:** add isSimilarityOnly + groupByTop pure helpers for rerank()
  ([ac830bf](https://github.com/artk0de/TeaRAGs-MCP/commit/ac830bf05651ceded5ca0ac95520b4d8d0d2c310))
- **explore:** collapse semantic+hybrid dispatchers, extract ctx builders
  ([e7a60ef](https://github.com/artk0de/TeaRAGs-MCP/commit/e7a60ef2f8c84e937bbab2b7d9417034cd0a8c61))
- **explore:** extract ExploreOps + close the cosmetic-thinning loophole in
  facade-discipline
  ([e24f107](https://github.com/artk0de/TeaRAGs-MCP/commit/e24f107f451737870fbb70dd83dae0c3adb343be))
- **explore:** extract findSimilar validation into validateFindSimilarRequest
  ([846a52e](https://github.com/artk0de/TeaRAGs-MCP/commit/846a52eca97cbd44a2e7e9b92238a6ec6adb0acc))
- **explore:** extract findSymbol into SymbolSearchStrategy +
  FileOutlineStrategy
  ([cc9cb8d](https://github.com/artk0de/TeaRAGs-MCP/commit/cc9cb8d5a672f5bb7e7c84c7f61ec3f0d553fcb8))
- **explore:** extract getIndexMetrics into IndexMetricsQuery
  ([c0cc189](https://github.com/artk0de/TeaRAGs-MCP/commit/c0cc18929ff5132586a9caf159080121dabd6d78))
- **explore:** extract resolveMode + scoreResults and rewrite rerank() as
  orchestrator
  ([8513700](https://github.com/artk0de/TeaRAGs-MCP/commit/85137007707ac5ada2cf938289b7ff03d570b2b6)),
  closes
  [Reranker#resolveMode](https://github.com/artk0de/Reranker/issues/resolveMode)
  [Reranker#scoreResults](https://github.com/artk0de/Reranker/issues/scoreResults)
- extract phases from createAppContext and
  TreeSitterChunker[#chunk](https://github.com/artk0de/TeaRAGs-MCP/issues/chunk)
  ([2f3047c](https://github.com/artk0de/TeaRAGs-MCP/commit/2f3047cc42f86cde6a987378fa58eace0682a75a))
- **ingest:** complete IngestFacade under facade-discipline iter-3
  ([ce5e9f8](https://github.com/artk0de/TeaRAGs-MCP/commit/ce5e9f8cd944261a55ab09d1395aad0417bb5312))
- **ingest:** decompose extractSignalValues into trajectory-owned
  StatsAccumulators
  ([f8e6967](https://github.com/artk0de/TeaRAGs-MCP/commit/f8e696777d13d11f2b47dc9fb2a7c8732e9ed68a))
- **ingest:** extract indexCodebase branching into IndexingOps
  ([38c9412](https://github.com/artk0de/TeaRAGs-MCP/commit/38c94120431ea606f3d39f6624e2381e984ca5bc))
- **mcp:** replace 5 copy-paste registerToolSafe blocks with SEARCH_TOOLS array
  ([7ef22c8](https://github.com/artk0de/TeaRAGs-MCP/commit/7ef22c8c170484f0081788b8508bd12a941d9492))

## [1.19.1](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.19.0...v1.19.1) (2026-04-10)

### Bug Fixes

- **build:** include benchmarks/ in published package
  ([0dd332c](https://github.com/artk0de/TeaRAGs-MCP/commit/0dd332c28979d024afe88388b362cdb99cc0ab9e))

## [1.19.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.18.0...v1.19.0) (2026-04-06)

### Features

- **api:** add relativePath parameter to find_symbol
  ([5ce07fa](https://github.com/artk0de/TeaRAGs-MCP/commit/5ce07fa49fd40b4ada839de662dfbf93a7941a81))
- **chunker:** use # separator for instance methods, . for static
  ([06fd221](https://github.com/artk0de/TeaRAGs-MCP/commit/06fd221f39fbb5c43e96f6f31e28912851265da2)),
  closes [Reranker#rerank](https://github.com/artk0de/Reranker/issues/rerank)
- **drift:** add schema-v11 migration for parentName → parentSymbolId rename
  ([405e52c](https://github.com/artk0de/TeaRAGs-MCP/commit/405e52cad444a4f0eae19a6864f0c74c744eb4a8))
- **explore:** add ChunkGrouper component (CodeChunkGrouper + DocChunkGrouper)
  ([eb02cfd](https://github.com/artk0de/TeaRAGs-MCP/commit/eb02cfd5ad4c7906fc0750840678df85faaa7f63))
- **explore:** chunk grouping — file outlines, doc TOC, #/. separator
  ([86e0fcf](https://github.com/artk0de/TeaRAGs-MCP/commit/86e0fcfa78c623df11a50a6b362530941131541c)),
  closes [Class#method](https://github.com/artk0de/Class/issues/method)
- **git:** add merge-branch-resolver for fix branch propagation
  ([b5fb30e](https://github.com/artk0de/TeaRAGs-MCP/commit/b5fb30edb84236f74fce634edbf5e608b0be215c))
- **git:** add offset-tracker for drift-free chunk attribution
  ([9b2ddaf](https://github.com/artk0de/TeaRAGs-MCP/commit/9b2ddafacbeaaa02b563d6996ed411c4e2b9d512))
- **git:** add parent SHAs to CommitInfo via %P in git log format
  ([ea048e4](https://github.com/artk0de/TeaRAGs-MCP/commit/ea048e48c95314a9a5fb45e4b6799a44085787dc))
- **onnx:** add resolveModelInfo for runtime dimensions and context length
  ([b1050b7](https://github.com/artk0de/TeaRAGs-MCP/commit/b1050b72fa6905220b35d8fe8c695f0770a028e7))
- **pipeline:** set parentName to relative path for doc chunks
  ([e99ac33](https://github.com/artk0de/TeaRAGs-MCP/commit/e99ac337ac7a85111cffaa7ec09ae7ee890b2426))
- **presets:** add 'dangerous' composite preset for high-risk code detection
  ([63010c9](https://github.com/artk0de/TeaRAGs-MCP/commit/63010c9e297cbb209f24dc03ca1a20c72e797c99))
- **presets:** add proven rerank preset for battle-tested code
  ([faf6533](https://github.com/artk0de/TeaRAGs-MCP/commit/faf65332646fd98033cc4874e04af743faa09e16))

### Improvements

- **api:** expose headingPath in API responses for agent navigation
  ([2742457](https://github.com/artk0de/TeaRAGs-MCP/commit/27424577549759a28abd95e778bf15f9fcc51a8b))
- **dx:** add mid-session reindex rule to search-cascade
  ([7e1f84a](https://github.com/artk0de/TeaRAGs-MCP/commit/7e1f84a75b25b8e44793d48a3a0ff35af2b83dc8))
- **dx:** persist eval cases for chunk-grouping + enforce in optimize-skill
  ([749de06](https://github.com/artk0de/TeaRAGs-MCP/commit/749de0670203ced2e1793bc1e82311da52c1aa0c))
- **dx:** update search-cascade for chunk grouping features
  ([e4ea7b5](https://github.com/artk0de/TeaRAGs-MCP/commit/e4ea7b5078b85e794b9a55027392f63ad20dc21e))
- **explore:** remove members array from ChunkGrouper output
  ([d7bda45](https://github.com/artk0de/TeaRAGs-MCP/commit/d7bda451b918461efdc8a5f9faa3f0dfe3e3e0dc))
- **explore:** slim down ChunkGrouper payload — no spread, explicit fields only
  ([3f028b4](https://github.com/artk0de/TeaRAGs-MCP/commit/3f028b469f7d57ca4a651330a0a8c1e76502616b))
- **mcp:** generate signal-labels resource dynamically from
  PayloadSignalDescriptors
  ([26b7a98](https://github.com/artk0de/TeaRAGs-MCP/commit/26b7a9810bd00f1c43de055dcf48e2805c5bd0bd))
- **mcp:** generate signal-labels resource dynamically from
  PayloadSignalDescriptors
  ([657fe70](https://github.com/artk0de/TeaRAGs-MCP/commit/657fe70343daf05eeee67bbe221ad8f77925d9ce))
- **signals:** wire merge-branch-resolver into chunk-level bugFixRate
  ([2ee0d25](https://github.com/artk0de/TeaRAGs-MCP/commit/2ee0d250f9408705304b3c5e30f2c1f42bc37e08))
- **signals:** wire merge-branch-resolver into file-level bugFixRate
  ([a074915](https://github.com/artk0de/TeaRAGs-MCP/commit/a074915d31d03a43c1e2ba0f206d251db91f031a))

### Bug Fixes

- **ci:** remove dead integration test step from pre-commit hook
  ([59b338d](https://github.com/artk0de/TeaRAGs-MCP/commit/59b338da3adbac0bd6c79b48f536356d1531ce9a))
- **embedding:** Ollama fallback race condition and cooldown bugs
  ([ed474f2](https://github.com/artk0de/TeaRAGs-MCP/commit/ed474f22291c91c6e83f1d80aec88ea5347b02f2))
- **explore:** merge essential trajectory fields with overlay in metaOnly
  ([cde0eda](https://github.com/artk0de/TeaRAGs-MCP/commit/cde0eda2edaa6d9f71c355164743eb91cc5b5af0))
- **git:** wire offset tracker into chunk-reader for drift-free attribution
  ([e8c4d54](https://github.com/artk0de/TeaRAGs-MCP/commit/e8c4d544c5a870a5bdb940041425f398554c329a))
- **qdrant:** countPoints error wrapping and deletion filter explosion
  ([d54a010](https://github.com/artk0de/TeaRAGs-MCP/commit/d54a0103d1e50fe660e87e161c853a44ec3af31d))
- **signals:** raise BugFixSignal FALLBACK_THRESHOLD from k=8 to k=10
  ([2f5ed3c](https://github.com/artk0de/TeaRAGs-MCP/commit/2f5ed3c53d89672507ed0df93f9188e7a9abb1e5))
- **signals:** rewrite isBugFixCommit with strict classification
  ([f880b76](https://github.com/artk0de/TeaRAGs-MCP/commit/f880b760addc73a7cc1b58a70b8e1bc22d5f0681)),
  closes [#123](https://github.com/artk0de/TeaRAGs-MCP/issues/123)
- **signals:** rewrite isBugFixCommit with strict classification
  ([01be60e](https://github.com/artk0de/TeaRAGs-MCP/commit/01be60ee1c687041357f0d35fb24fda52ee12d0b)),
  closes [#123](https://github.com/artk0de/TeaRAGs-MCP/issues/123)

### Documentation

- **explore:** add outlineDoc strategy + chunk-grouping plan
  ([f8a2565](https://github.com/artk0de/TeaRAGs-MCP/commit/f8a2565b5958d4e0e8b53c8e13836e7e83c115d6))
- **mcp:** update find_symbol description with #/. separator convention
  ([b82c9fc](https://github.com/artk0de/TeaRAGs-MCP/commit/b82c9fc4efe47ddde8a094caa3bb2df3099af7a6))
- **mcp:** update search-guide and overview resources for chunk grouping
  ([ebcf9fc](https://github.com/artk0de/TeaRAGs-MCP/commit/ebcf9fc69c31a726c87cc9880da410516b48791f))
- **signals:** add bugFixRate accuracy implementation plan
  ([b103683](https://github.com/artk0de/TeaRAGs-MCP/commit/b103683b26dbdf32facc09c079b6d8c77d3b12fa))
- **signals:** update bugFixRate detection rules in website docs
  ([24f1dfa](https://github.com/artk0de/TeaRAGs-MCP/commit/24f1dfa76ee50373c7c06620f89a7d520abe03ed))
- **signals:** update bugFixRate plan — k=10, drift fix via offset tracker
  ([fcf8d2a](https://github.com/artk0de/TeaRAGs-MCP/commit/fcf8d2ae71387a98767a98101e1d087feac737ec))
- **specs:** add file-level find_symbol design spec
  ([74a28d7](https://github.com/artk0de/TeaRAGs-MCP/commit/74a28d7015f82599059e07adc72c1c967c39ab03))

### Code Refactoring

- **api:** rename parentName → parentSymbolId across codebase
  ([227bbcb](https://github.com/artk0de/TeaRAGs-MCP/commit/227bbcb4832fb71fc55993570f2181905aa302cb))
- **explore:** integrate ChunkGrouper into resolveSymbols
  ([178a051](https://github.com/artk0de/TeaRAGs-MCP/commit/178a051972a4df69e4d025610a4000d9f4cb80d3))
- **mcp:** deduplicate search-guide — examples only, routing in cascade
  ([413b03b](https://github.com/artk0de/TeaRAGs-MCP/commit/413b03b9975dea7ad5b0b60f3719479eb5fa84cf))
- **test:** split git-log-reader.test.ts into domain-specific modules
  ([f4677c2](https://github.com/artk0de/TeaRAGs-MCP/commit/f4677c24ef0d36ab8231e4824f82c979983a3f7d))

## [1.18.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.17.6...v1.18.0) (2026-04-01)

### Features

- **adapters:** add OllamaEmbeddings.resolveModelInfo() via /api/show
  ([38b2da8](https://github.com/artk0de/TeaRAGs-MCP/commit/38b2da8b3b2cd0d6f2d74a88eb60cdcf4a4b0b5c))
- **chunker:** write headingPath to markdown chunk metadata
  ([5e7cf76](https://github.com/artk0de/TeaRAGs-MCP/commit/5e7cf76bb93fc264793f7dc23491cbb0e81bd900))
- **drift:** track navigation field in schema drift detection
  ([5dcb0a2](https://github.com/artk0de/TeaRAGs-MCP/commit/5dcb0a2ee0569bd39feef749fe240bed19d74525))
- **dto:** add stripInternalFields to hide headingPath from API responses
  ([a2c0fa5](https://github.com/artk0de/TeaRAGs-MCP/commit/a2c0fa566f48409f789e8cd18369c86ec8cc05bc))
- **ingest:** auto-detect model context and dimensions from Ollama
  ([cd38fd0](https://github.com/artk0de/TeaRAGs-MCP/commit/cd38fd04c6fa773edfce528ae8b42374cb8b252c))
- **migration:** schema v10 — purge markdown chunks for re-chunking
  ([3d68028](https://github.com/artk0de/TeaRAGs-MCP/commit/3d680284ff946af024d0006a881704672fbc4e2f))
- **pipeline:** generate doc symbolId hashes and navigation links
  ([95c65cc](https://github.com/artk0de/TeaRAGs-MCP/commit/95c65cc2689af397c3cd4f58834888e07e94f566))
- **presets:** add documentationRelevance preset with auto-activation
  ([79c81e4](https://github.com/artk0de/TeaRAGs-MCP/commit/79c81e4923e5791ce13d1ceb935bf68e8bc94fb7))
- **signals:** add HeadingRelevanceSignal for markdown heading boost
  ([1fee0e2](https://github.com/artk0de/TeaRAGs-MCP/commit/1fee0e2242fee6adf7dbf7b56a38216b7c399a15))
- **trajectory:** write navigation and headingPath to Qdrant payload
  ([e2a9e93](https://github.com/artk0de/TeaRAGs-MCP/commit/e2a9e930382daa2fe6fcc2009f190169a594312a))
- **types:** add navigation field to CodeChunk metadata
  ([6245061](https://github.com/artk0de/TeaRAGs-MCP/commit/6245061d7de63e606e01fb82c80c4f3f44ef426f))

### Improvements

- **chunker:** group small h3 sections into parent h2 chunk
  ([ec49fe0](https://github.com/artk0de/TeaRAGs-MCP/commit/ec49fe02137926e38a00cab6d4cf58f319e14173))
- **dx:** optimize coverage-expander agent for tea-rags and npm scripts
  ([8f45f3f](https://github.com/artk0de/TeaRAGs-MCP/commit/8f45f3faee73e0f15d55ee79437f9665017b29fc))

### Bug Fixes

- **adapters,chunker:** Ollama error taxonomy and markdown chunk splitting
  ([d1649c5](https://github.com/artk0de/TeaRAGs-MCP/commit/d1649c5efa3d43d135a9adb6cccb532f0cf2a3de))
- **adapters:** prevent mid-operation URL switching in Ollama fallback
  ([3a60511](https://github.com/artk0de/TeaRAGs-MCP/commit/3a60511ce4980aafd36119d51ae1011884fd8db9))
- **adapters:** replace OperationLock with per-operation URL snapshot in Ollama
  fallback
  ([73d617e](https://github.com/artk0de/TeaRAGs-MCP/commit/73d617e0fc4499f7512c409efe69e49bf3e8514c))
- **chunker:** include grouped h3 headings in headingPath
  ([51d12e4](https://github.com/artk0de/TeaRAGs-MCP/commit/51d12e4d185e5c7680bf9d03ca8f672af72e3b30))
- **explore:** move collection existence check to resolveAndGuard
  ([5a422ae](https://github.com/artk0de/TeaRAGs-MCP/commit/5a422ae24675fb4773a94c985d981bab0705ce58))
- **ingest:** lower CHARS_PER_TOKEN from 3 to 2 for safer context cap
  ([1e8fece](https://github.com/artk0de/TeaRAGs-MCP/commit/1e8fece7012e68627aa052c2d432c5db72a17086))
- **migration:** use mtime=0 instead of hash="" for snapshot invalidation
  ([f831b8a](https://github.com/artk0de/TeaRAGs-MCP/commit/f831b8acf383eb5c7f2414f82ad1be2f0350d852))
- **pipeline:** persist sparseVersion in schema metadata on fresh index
  ([99dbc95](https://github.com/artk0de/TeaRAGs-MCP/commit/99dbc9541e1b68691ac629410aa14ee1109aa673))
- **pipeline:** skip secrets detection for test files
  ([1ba9856](https://github.com/artk0de/TeaRAGs-MCP/commit/1ba9856300dd6d33bedad59d2e00638d19ac0f89))
- **scripts:** save tune history to ~/.tea-rags/benchmarks and show Qdrant mode
  ([56fa223](https://github.com/artk0de/TeaRAGs-MCP/commit/56fa2230a9693786c3f430ebe28d8056baf5ed8e))

### Documentation

- **dx:** add chunk navigation guidance to search-cascade
  ([af875be](https://github.com/artk0de/TeaRAGs-MCP/commit/af875be926f78f58642f58b4b6f59e1ef9bd3cf6))
- **plans:** add chunk navigation implementation plan
  ([7c5cb24](https://github.com/artk0de/TeaRAGs-MCP/commit/7c5cb2468d8f49481f76e3039bfd80705375aa1c))
- **plans:** add Ollama model info auto-detection implementation plan
  ([3fd1332](https://github.com/artk0de/TeaRAGs-MCP/commit/3fd1332f272dab7968583b18fba9c3cacf96db31))
- **rules:** add snapshot invalidation guide to migration rules
  ([730438b](https://github.com/artk0de/TeaRAGs-MCP/commit/730438b27bc6b2a224df77c9cbfb2e97334d3564))
- **search-cascade:** add documentation rerank auto-activation rule
  ([a368c1d](https://github.com/artk0de/TeaRAGs-MCP/commit/a368c1dde1715aa4550ee1b30eac7ed292b9f7f8))
- **specs:** add chunk navigation design spec
  ([fc19cd7](https://github.com/artk0de/TeaRAGs-MCP/commit/fc19cd718e003e31d0109e41d7cd2b7bcae350cf))
- **specs:** add heading relevance boost design spec and plan
  ([65d59d3](https://github.com/artk0de/TeaRAGs-MCP/commit/65d59d3631b0ca9d4b1798bb992e880d7492490e))
- **specs:** add Ollama model info auto-detection design
  ([73c7a29](https://github.com/artk0de/TeaRAGs-MCP/commit/73c7a2978538027c03109f7863d8c1a9826c1ffa))

## [1.17.6](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.17.5...v1.17.6) (2026-03-30)

### Improvements

- **embedding:** add Ollama fallback switch observability to pipeline log
  ([d2c4665](https://github.com/artk0de/TeaRAGs-MCP/commit/d2c4665b4b48e454151d98a59949990251fc08ab))

### Bug Fixes

- **pipeline:** self-correcting recovery guard detects stale markers
  ([4103e1e](https://github.com/artk0de/TeaRAGs-MCP/commit/4103e1e5bdbfacf553aeb4a10bc3f51cdcaca7fd))
- **pipeline:** skip enrichment recovery when marker shows all enriched
  ([9b21ea7](https://github.com/artk0de/TeaRAGs-MCP/commit/9b21ea7a24d90e2dc72b3baf9a07af5d3a144a0e))

### Performance Improvements

- **pipeline:** deduplicate facade pre-checks, remove index skill subagent
  ([d79943b](https://github.com/artk0de/TeaRAGs-MCP/commit/d79943b9e37e04a861e5a9da2c11496af09141ce))
- **pipeline:** local file guard for recovery, fire-and-forget execution
  ([ba48370](https://github.com/artk0de/TeaRAGs-MCP/commit/ba48370d84809e48e3cb0d65d19256ea4b27d442))
- **pipeline:** make refreshStats non-blocking for incremental reindex
  ([6a74f30](https://github.com/artk0de/TeaRAGs-MCP/commit/6a74f30132f9c8e1f7308d2a4de6ec2ba131d125))

## [1.17.5](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.17.4...v1.17.5) (2026-03-30)

### Improvements

- **dx:** enforce tea-rags search injection for all subagents
  ([bede8e9](https://github.com/artk0de/TeaRAGs-MCP/commit/bede8e94ec2304cd958ee6c2baaa5f7a3b069bda))

## [1.17.4](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.17.3...v1.17.4) (2026-03-30)

### Bug Fixes

- **dx:** resolve plugin source paths relative to repo root
  ([910f1df](https://github.com/artk0de/TeaRAGs-MCP/commit/910f1dffc2f4bed8ebbdd880f0c7d21c1fc7a063))

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
  SignalMetrics&gt; to Record&lt;language, Record&lt;signalKey, SignalMetrics&gt;&gt;. Global
  stats are now under signals["global"]. Per-language stats under
  signals["typescript"] etc. Consumers must update to access signals.global
  instead of signals directly.

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
