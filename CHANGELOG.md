## [1.50.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.49.0...v1.50.0) (2026-10-31)

### ⚠ BREAKING CHANGES

- **migration:** Converted codegraph databases use DuckDB 2.0 storage. Older
  tea-rags builds cannot open converted files. Use this or a newer build, or
  restore a pre-conversion backup before downgrading.
- **api:** workingTree.changedFiles / deletedFiles are omitted unless the marker
  also carries degraded, pendingFiles, indexOnlyFiles, unparsed,
  treeGraphUnavailable, denseUnavailable or gitUnavailable.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

- **explore:** hybrid_search / semantic_search answers no longer include a
  find_co_changed entry in next; next holds at most get_callees and get_callers.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

- **explore:** search tools' default rows no longer carry id, score, chunkType,
  language or navigation; reranked content rows no longer carry the whole
  payload. Pass `fields` for any of them.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

- **api:** workingTree on MCP answers no longer carries floors, indexedCommit,
  treeCommit or indexedDirty; changedFiles / deletedFiles are omitted when 0 (a
  clean marker is { tree, project? }, no changedFiles: 0).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

- **trajectory:** CODEGRAPH_RUST_ANALYZER, CODEGRAPH_RUST_ANALYZER_EXEC,
  CODEGRAPH_RUST_ANALYZER_PATH, CODEGRAPH_RUST_ANALYZER_TIMEOUT_SEC and
  CODEGRAPH_RUST_ANALYZER_MAX_RSS_MB are no longer read; the rustc call-site
  driver (CODEGRAPH_RUST_DRIVER\*) replaces rust-analyzer SCIP, and the
  "rust-analyzer not found" hint is gone.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

- **mcp:** text tool output is compact JSON, and arrays of two or more records
  are { columns, rows } tables. Consumers that indexed such arrays
  (callers[i].symbolId) read column symbolId of row i.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

- **mcp:** structuredContent.results of the five search tools is a { columns,
  rows } table instead of an array of result objects. Clients that read
  results[i].payload must read column payload.<key> of row i.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

### Plugin

- **dinopowers:** Codex T22 failures — verdicts, bundles and hand-offs spelled
  out
  ([c4331f9](https://github.com/artk0de/TeaRAGs-MCP/commit/c4331f9c209c4758f79c18258eb16fd1b409680b))
- **dinopowers:** round-3 eval fixes — codegraph decision before enrichment,
  diff gate defers to DDG Step 7, DDG owns RED/GREEN
  ([016c807](https://github.com/artk0de/TeaRAGs-MCP/commit/016c807f665224fe64d37ba6f21e5c9f0bf40d22))
- **dinopowers:** round-4 eval fixes — wrapper named first, tests stay inside
  DDG, supplementary calls allowed after the scan
  ([088b8be](https://github.com/artk0de/TeaRAGs-MCP/commit/088b8be57c76362dc7e2f2230ea1d0dc85203e75))
- **dinopowers:** stop and ask for superpowers when the wrapped skill is missing
  ([c4ced5e](https://github.com/artk0de/TeaRAGs-MCP/commit/c4ced5ec7bdbfc267fe10dc1acbbe8805164cff1))
- **dinopowers:** wrapper Iron Rules hold under user overrides; verdict ladders
  ordered
  ([c68ec2a](https://github.com/artk0de/TeaRAGs-MCP/commit/c68ec2a8614c80323e401e044afa9edaceffafc4))
- **plugin:** anchor rule calls the graph first, then one batch (9u17t)
  ([14d3e1e](https://github.com/artk0de/TeaRAGs-MCP/commit/14d3e1e24cc234938d48a27b1fbfece6508f341c))
- **plugin:** balanced routing, no indexed-read deny, file batches (nxg76,
  ednnx)
  ([66a73ea](https://github.com/artk0de/TeaRAGs-MCP/commit/66a73eab64c408b43bd662cc99d9f6a3b313fa4d))
- **plugin:** class answers carry header code + method outline (plugin 0.53.4)
  ([7e88d62](https://github.com/artk0de/TeaRAGs-MCP/commit/7e88d621bb9aec59cd171424235a1524b0c5a82a))
- **plugin:** freshness guide and harness matrix drop the removed indexed-read
  deny (nxg76)
  ([4665127](https://github.com/artk0de/TeaRAGs-MCP/commit/46651275e71b162ffc9ae5085874c8797d567d26))
- **plugin:** keep measured rates out of the Rust driver cascade rule
  ([ac846c3](https://github.com/artk0de/TeaRAGs-MCP/commit/ac846c3599f9e54203b4072621231fb7140bced4))
- **plugin:** overview template states search-row compaction (imports count,
  2-sig floats)
  ([12bb4cb](https://github.com/artk0de/TeaRAGs-MCP/commit/12bb4cbe3387bf925b86267c2b25679e125d2200))
- **plugin:** plugin-sources rule, generated paths out of the index, Task 18
  decisions
  ([8399491](https://github.com/artk0de/TeaRAGs-MCP/commit/839949182019b84ef3dec4b08774abf2325815f4))
- **plugin:** preserve filename coverage and scan metadata first
  ([bebbe5b](https://github.com/artk0de/TeaRAGs-MCP/commit/bebbe5bb3f101b432f9822384100d145ed269e1f))
- **plugin:** read known methods directly and gate diagnostics
  ([177bf56](https://github.com/artk0de/TeaRAGs-MCP/commit/177bf56bbd8dcd5e14a74eba2ff6f00f3dda3a36))
- **plugin:** reread-ledger names covering outline ids for slices and grep hits
  ([23e6ee6](https://github.com/artk0de/TeaRAGs-MCP/commit/23e6ee67ded3dfae93d8e4a056f80b4488e50b73))
- **plugin:** reread-ledger nudges raw reads of indexed source to find_symbol
  ([7125bc2](https://github.com/artk0de/TeaRAGs-MCP/commit/7125bc23dfdc974151cd60fb40444daaf9fefdfe))
- **plugin:** retain source paths and reuse Codex context
  ([8cabb11](https://github.com/artk0de/TeaRAGs-MCP/commit/8cabb11aee4027d071e767d6251c5cbd0cf40beb))
- **plugin:** reuse trusted context and read code selectively
  ([97afcd5](https://github.com/artk0de/TeaRAGs-MCP/commit/97afcd5827f57a11d2d84351f2a972a580b372ec))
- **plugin:** route ticket drills, column checks and ignoredPath answers (d9w4o)
  ([a1a575f](https://github.com/artk0de/TeaRAGs-MCP/commit/a1a575f24db48096835ef30203bd39bd391229e1))
- **plugin:** setup wizard offers the Rust compiler driver toolchain
  ([6dae82f](https://github.com/artk0de/TeaRAGs-MCP/commit/6dae82f073707bff9b9a86c6c36f991918b25b2a))
- **plugin:** tell the user once that Rust graph edges are static-only without
  the rustc driver
  ([24d1b37](https://github.com/artk0de/TeaRAGs-MCP/commit/24d1b378f23d536989e4be3a7ab6017ebdbe4986))

### Features

- **adapters:** emit and serve rustc driver local and indirect callee rows
  (RESIDUAL R4)
  ([d414d50](https://github.com/artk0de/TeaRAGs-MCP/commit/d414d509b88b697a6460f61db7768ca0e4fedc21))
- **adapters:** emit and serve rustc driver macro-invocation rows (RESIDUAL R3)
  ([bb4296a](https://github.com/artk0de/TeaRAGs-MCP/commit/bb4296a86360d1e277140372728493f90c5676f5))
- **adapters:** first-use rustc driver build with latch and atomic install
  (s3i8m T3)
  ([0038c15](https://github.com/artk0de/TeaRAGs-MCP/commit/0038c15348357d1ed221ae32db623d6c1ec2d7bd))
- **adapters:** rust-analyzer SCIP cache reuses unchanged files on incremental
  runs (s3i8m.6 R2b-2)
  ([4c6d2d4](https://github.com/artk0de/TeaRAGs-MCP/commit/4c6d2d4b2b268c19286766134d5f68e7a3c09adf))
- **adapters:** rustc call-site driver crate native/rust-callsites (s3i8m T1)
  ([a30889a](https://github.com/artk0de/TeaRAGs-MCP/commit/a30889a2284a81c60485aa7eba5fe8239fcb9f9c))
- **adapters:** rustc call-site driver discovery tiers and install hint (s3i8m
  T2)
  ([0794aba](https://github.com/artk0de/TeaRAGs-MCP/commit/0794aba2e525a7d1c78fc1de06e81e979555de0a))
- **adapters:** rustc call-site NDJSON decoder into the definitionAt lookup
  (s3i8m T5)
  ([7efa3b7](https://github.com/artk0de/TeaRAGs-MCP/commit/7efa3b739ecd1596c888a120fb3a14955f60b8d9))
- **adapters:** rustc driver marks macro-generated callee definitions (format 4
  defExpansion)
  ([4518fb3](https://github.com/artk0de/TeaRAGs-MCP/commit/4518fb30c508686fcfff95dc2339ecabad03454d))
- **adapters:** supervised rustc call-site runner with envKey and latch lattice
  (s3i8m T4)
  ([27b2a0b](https://github.com/artk0de/TeaRAGs-MCP/commit/27b2a0b80fe62dda899f6e83ead4aa2521af9f37))
- **adapters:** wire the rustc call-site driver source, env slot and tally flag
  (s3i8m T8)
  ([a9c67aa](https://github.com/artk0de/TeaRAGs-MCP/commit/a9c67aa4fab88a81f8e98ad283f6a05c7f434087))
- **api:** compact clean workingTree marker, alwaysLoad find_symbol and
  hybrid_search
  ([39cfaac](https://github.com/artk0de/TeaRAGs-MCP/commit/39cfaac29deb9f5b733bacf615832b6d172f8087))
- **api:** compact list_projects rows, full record via project param
  ([59df148](https://github.com/artk0de/TeaRAGs-MCP/commit/59df1481080dda6bf16986a28b9672bc3d730ed6)),
  closes [App#listProjects](https://github.com/artk0de/App/issues/listProjects)
- **api:** compact search rows - imports as count, all-null columns dropped,
  2-sig floats
  ([e1a6140](https://github.com/artk0de/TeaRAGs-MCP/commit/e1a6140e5e9db5971ba3d464d312c2f0ba0a64f9))
- **api:** depth call trees and offset paging on get_callers / get_callees
  (afdpc)
  ([36bb308](https://github.com/artk0de/TeaRAGs-MCP/commit/36bb30835484c6aae9388dbaddd54536fc20ac7a))
- **api:** experimental locate tool behind EXPERIMENTAL_LOCATE_ENABLE (hidden by
  default)
  ([9143369](https://github.com/artk0de/TeaRAGs-MCP/commit/9143369a6256af5d6064a047aab78c404b1bc0b8)),
  closes
  [ToolDependencies#experimentalLocate](https://github.com/artk0de/ToolDependencies/issues/experimentalLocate)
- **api:** ExploreResponse carries empty-answer reason and next calls
  ([36b4690](https://github.com/artk0de/TeaRAGs-MCP/commit/36b46903410720c3d3121a31bc55ae99a2c81831))
- **api:** find_symbol batch drill (symbols) and directory outline
  ([254ab36](https://github.com/artk0de/TeaRAGs-MCP/commit/254ab36a400457584e7c15de953a5978aacbd2dd))
- **api:** graph and co-change empty answers explain themselves (N6)
  ([e36d0f1](https://github.com/artk0de/TeaRAGs-MCP/commit/e36d0f126c5ea461e2d54ec79838ccd3ed01a713))
- **api:** group get_architecture_report violations per detector, trim evidence
  ([2a2135b](https://github.com/artk0de/TeaRAGs-MCP/commit/2a2135b6cbcca5fe3495f90b97cbef550621d7e6)),
  closes
  [GraphFacade#getArchitectureReport](https://github.com/artk0de/GraphFacade/issues/getArchitectureReport)
- **api:** lead decision-point tool answers with a one-line banner (nknkg.3)
  ([7f4d10a](https://github.com/artk0de/TeaRAGs-MCP/commit/7f4d10a6cbe672dbc567dfdae4ac90dfc93d2fa3))
- **api:** page get_architecture_report from a held judgement by reportId
  ([6857742](https://github.com/artk0de/TeaRAGs-MCP/commit/685774246ed32f260b1a89c0c672a40c16ebce20)),
  closes
  [ArchitectureReportOps#judge](https://github.com/artk0de/ArchitectureReportOps/issues/judge)
  [GraphFacade#getArchitectureReport](https://github.com/artk0de/GraphFacade/issues/getArchitectureReport)
- **api:** serialize the workingTree marker as only what the agent acts on
  (q1g6s.15)
  ([5620246](https://github.com/artk0de/TeaRAGs-MCP/commit/5620246b7294f6b141a256ef6667ec5f7bfcc7ad))
- **api:** toColumns — record arrays as column tables (zn0fg)
  ([b117486](https://github.com/artk0de/TeaRAGs-MCP/commit/b117486e5bd358c94428e5c5ac512dd2dbf21e3f))
- **api:** trim over-budget tool answers to 12k tokens with a truncated
  continuation
  ([18df5ca](https://github.com/artk0de/TeaRAGs-MCP/commit/18df5ca7f7c04b2b2f5a5fc61743c5b67c451dcf))
- **api:** workingTree marker names the answering project alias (iqx9x)
  ([67eae6a](https://github.com/artk0de/TeaRAGs-MCP/commit/67eae6adec309018f953d5dcecc271d1df3833f7))
- **chunker:** extract Rails migration operations (vx81b)
  ([bbcc59a](https://github.com/artk0de/TeaRAGs-MCP/commit/bbcc59ad325de3b6853b53b58e64351623dadf16))
- **chunker:** index .rake as the Rake DSL with task symbols in chunks and
  codegraph (k0602)
  ([713682b](https://github.com/artk0de/TeaRAGs-MCP/commit/713682b098c36989f3a6365ec7746fdbdc34159a))
- **chunker:** index config YAML as a doc-only yaml language (q1g6s.7)
  ([2065078](https://github.com/artk0de/TeaRAGs-MCP/commit/2065078ce7ef664e1e678f9c13aa74f6049dbf3f)),
  closes
  [relPath#production](https://github.com/artk0de/relPath/issues/production)
- **chunker:** Ruby class-level DSL statements are addressable members
  ([41cda8e](https://github.com/artk0de/TeaRAGs-MCP/commit/41cda8e85faa6f00187260c58a76c63de9b3b718)),
  closes [Owner#chapters](https://github.com/artk0de/Owner/issues/chapters)
  [Owner#status](https://github.com/artk0de/Owner/issues/status)
- **cli:** doctor --footprints lists unused collection footprints, --fix purges
  them (expwb)
  ([4ca6057](https://github.com/artk0de/TeaRAGs-MCP/commit/4ca6057be709abc9a98208981dcdd516e2692143))
- **cli:** prime signal thresholds as one table row per signal (zn0fg)
  ([125c775](https://github.com/artk0de/TeaRAGs-MCP/commit/125c775b13a14590f54ad1be6c45806bc26a2280))
- **cli:** subagents learn the repository's project alias (4nqf5)
  ([6f692fc](https://github.com/artk0de/TeaRAGs-MCP/commit/6f692fc975447f47b505749581eafaab8ebccbad))
- **cli:** tea-rags call --format json prints records, not column tables (zn0fg)
  ([1fdf0c7](https://github.com/artk0de/TeaRAGs-MCP/commit/1fdf0c752a245dec3bd68e1a49ff47f5c07b62a1))
- **cli:** tea-rags update brings the Claude Code plugins along (zn0fg)
  ([be5508a](https://github.com/artk0de/TeaRAGs-MCP/commit/be5508a8f0ebc0552e45e397568d7167d0b484b8))
- **codex:** core makes Codex read a skill this turn and the skill a wrapper
  hands off to
  ([9532187](https://github.com/artk0de/TeaRAGs-MCP/commit/9532187a56ac207241845c0d3565e95e63cd1f66))
- **codex:** core reads one file per command and resolves repair/ and rules/
  from the plugin root
  ([6b6d712](https://github.com/artk0de/TeaRAGs-MCP/commit/6b6d71212c0fcc05b1d6bbf6f477b58945650ec7))
- **config:** MCP_SERVER_INSTRUCTIONS=pointer sends only the core pointer line
  (q1g6s.3)
  ([2110726](https://github.com/artk0de/TeaRAGs-MCP/commit/2110726f08ff69ced1903869c69f6aad523e861f))
- **contracts:** empty-answer reasons and suggested tool call address
  ([2b93f0a](https://github.com/artk0de/TeaRAGs-MCP/commit/2b93f0a1314aa21a648e48749fb2c2bda025b33e))
- **drift:** repeat drift reports ride as a one-line digest pointer (q1g6s.15)
  ([ab5816c](https://github.com/artk0de/TeaRAGs-MCP/commit/ab5816ce7d05304a5edd5997f3b77a08e0b37412)),
  closes
  [IndexDriftReporter#checkAndConsume](https://github.com/artk0de/IndexDriftReporter/issues/checkAndConsume)
  [#checkAndConsumeByCollectionName](https://github.com/artk0de/TeaRAGs-MCP/issues/checkAndConsumeByCollectionName)
  [ExploreOps#checkDrift](https://github.com/artk0de/ExploreOps/issues/checkDrift)
  [App#checkIndexDrift](https://github.com/artk0de/App/issues/checkIndexDrift)
- **dx:** Codex SessionStart hands core rules with the prime digest
  ([524d1c7](https://github.com/artk0de/TeaRAGs-MCP/commit/524d1c7c7a5889a7e365cd70026b5101cc8c8469))
- **dx:** Codex shell hook denies reading an indexed file (mqhlr)
  ([9927838](https://github.com/artk0de/TeaRAGs-MCP/commit/9927838321840b77bd1ccea9c9034b7ba8de2caf))
- **dx:** Cursor harness wires every Claude hook it has an event for (xkbkv)
  ([56a41bb](https://github.com/artk0de/TeaRAGs-MCP/commit/56a41bb5e038e89464f39009981163e67ff708f0))
- **dx:** deny Read/Bash reads of indexed files via a PreToolUse hook (ueplg)
  ([034717e](https://github.com/artk0de/TeaRAGs-MCP/commit/034717e40206620d2e2b2d17e198653348ab383f))
- **dx:** harness generators name the client's code search tool; freshness
  literals for pending and subagent drift
  ([46f7ad7](https://github.com/artk0de/TeaRAGs-MCP/commit/46f7ad7d25be8bd7acdb0e4c3bcaea51c04dbe89))
- **dx:** per-channel agent-context caps, codex-description, T22 r39 forks
  ([b3bcd01](https://github.com/artk0de/TeaRAGs-MCP/commit/b3bcd012eaa269f4728b8f86ba6f7c9ed0d18d99))
- **dx:** per-turn routing re-inject and search-drift deny hook on
  Claude/Codex/Cursor (nknkg.2)
  ([0ced20a](https://github.com/artk0de/TeaRAGs-MCP/commit/0ced20a159fe4f5aa99eb13384eeae8f1d0fc536))
- **evals:** recover rebench, Pro, probe and localization stages
  ([66e71ab](https://github.com/artk0de/TeaRAGs-MCP/commit/66e71abdc438731975e36a928a04ce14755b16bc))
- **explore:** add explicit Rails migration search scope (vx81b)
  ([b2d5e55](https://github.com/artk0de/TeaRAGs-MCP/commit/b2d5e5555b1312d1fc5b59ce06758f8297f1f681))
- **explore:** empty search answers explain themselves (N6)
  ([e001c3c](https://github.com/artk0de/TeaRAGs-MCP/commit/e001c3c6ea1c2db085df5ed1d7a0becdd6b77161))
- **explore:** find_similar example ids accept symbolIds (q1g6s.16)
  ([efc611d](https://github.com/artk0de/TeaRAGs-MCP/commit/efc611d3b18936a2a1446936e8dc2c0ccad4ad7b))
- **explore:** find_symbol answers a small file with its full text (03yel)
  ([320972f](https://github.com/artk0de/TeaRAGs-MCP/commit/320972f378e409072ab90e474d894708889896fd))
- **explore:** find_symbol answers ignoredPath for a tree path ingest leaves out
  (d9w4o)
  ([0ce0dc0](https://github.com/artk0de/TeaRAGs-MCP/commit/0ce0dc062cea2f3eaa36244eff7925143f845fc6))
- **explore:** find_symbol symbols batch answers file paths beside symbol ids
  (q1g6s.4)
  ([e037430](https://github.com/artk0de/TeaRAGs-MCP/commit/e037430fdc2c3b2dd028fe0faf1cfe0bc8fbaca2)),
  closes [B#c](https://github.com/artk0de/B/issues/c)
- **explore:** find_symbol table:<name> folds a Rails table's migrations into
  current state (nplgm)
  ([4b79274](https://github.com/artk0de/TeaRAGs-MCP/commit/4b7927413e8ad3aa089e216d8f4d55df68bec885)),
  closes [#partN](https://github.com/artk0de/TeaRAGs-MCP/issues/partN)
- **explore:** fuse several query variants in one semantic/hybrid search call
  (2vuz)
  ([83e5399](https://github.com/artk0de/TeaRAGs-MCP/commit/83e53992fe023966a0b459567f13b236b86af2d4)),
  closes
  [EmbeddingProvider#embedBatch](https://github.com/artk0de/EmbeddingProvider/issues/embedBatch)
  [QdrantSearchExecutor#fusedSearch](https://github.com/artk0de/QdrantSearchExecutor/issues/fusedSearch)
- **explore:** lean default fields for search tools (q1g6s.16)
  ([37a3724](https://github.com/artk0de/TeaRAGs-MCP/commit/37a3724181b975b62eacf6c12fca3c9e185676b2))
- **explore:** lean default payload per call mode and next expansion hints
  ([a8a0abb](https://github.com/artk0de/TeaRAGs-MCP/commit/a8a0abbf34d52655d834541db11c5645dd2af4ad))
- **explore:** search answers carry at most two next hints, no co-change
  (q1g6s.15)
  ([eaa0bd3](https://github.com/artk0de/TeaRAGs-MCP/commit/eaa0bd34d0515618426368963a7d0cca50f6a273))
- **harness:** repository root is the Codex and Cursor marketplace
  ([a679a30](https://github.com/artk0de/TeaRAGs-MCP/commit/a679a30175729ffa8a340adbb2dc0ae7307063c1))
- **harness:** ship dinopowers as its own Codex and Cursor plugin
  ([59cac8b](https://github.com/artk0de/TeaRAGs-MCP/commit/59cac8b8745d8d36bd441db92e8f78260d2bc068))
- **ingest:** index Rails migrations in a separate corpus (vx81b)
  ([298bd43](https://github.com/artk0de/TeaRAGs-MCP/commit/298bd4302e5b4741122f5a8d2eafb3571ab803e3))
- **ingest:** persist deterministic no-points skips in a per-collection skip
  record (6xdwe)
  ([d8f5f8c](https://github.com/artk0de/TeaRAGs-MCP/commit/d8f5f8c196f52d29b45dfb5e8667b95ab44319ca)),
  closes
  [SourceFileIngestor#ingest](https://github.com/artk0de/SourceFileIngestor/issues/ingest)
- **mcp:** project digest and metrics resource templates
  ([05574fc](https://github.com/artk0de/TeaRAGs-MCP/commit/05574fc5bf54f8fdfd93dfcba83dec1254d0316d))
- **mcp:** search results as column tables (zn0fg)
  ([27932e3](https://github.com/artk0de/TeaRAGs-MCP/commit/27932e3d6e6f9ab6633ced15d9d43b33943791cf))
- **mcp:** server instructions carry the always-on tea-rags core
  ([f88d972](https://github.com/artk0de/TeaRAGs-MCP/commit/f88d9725a3b3faeca41df6d01b8564f2bd39f5c2))
- **mcp:** tea-rags resource <uri> reads MCP resources through the in-process
  session
  ([7d25bc0](https://github.com/artk0de/TeaRAGs-MCP/commit/7d25bc095e2d84165aff5d61c8305a9d0e8b2f42))
- **mcp:** tea-rags://guide/\* namespace generated from plugin rules; drop
  per-collection listing
  ([f9bcefc](https://github.com/artk0de/TeaRAGs-MCP/commit/f9bcefc8810813dab84c4546897b619a6846e087))
- **mcp:** text tool responses compact, record arrays tabulated (zn0fg)
  ([3e8744d](https://github.com/artk0de/TeaRAGs-MCP/commit/3e8744d0acb1737bd82b2e970bc8d48757c76da4))
- **migration:** convert codegraph databases to DuckDB 2.0 storage (r1c0s)
  ([3d4400b](https://github.com/artk0de/TeaRAGs-MCP/commit/3d4400b9682b7a04670e7bf39c335152cdfd5e0a))
- **plugins:** Codex hook enforces one skill file per read; literal answer
  contracts (Codex round 19)
  ([6bb4c56](https://github.com/artk0de/TeaRAGs-MCP/commit/6bb4c5696ea91c99ea6147aae3f7391d61639976))
- **plugins:** reread-ledger hook notes lines the session already holds
  ([00744c5](https://github.com/artk0de/TeaRAGs-MCP/commit/00744c56f63eac5bc6fbae67d54badc1ffdc669e))
- **scripts:** Codex harness package generated from the plugin sources
  ([80525ce](https://github.com/artk0de/TeaRAGs-MCP/commit/80525ce04d5ad0af3f3c9e78e141e3a863eee3b8))
- **scripts:** Cursor gets a separate always-apply tool-execution rule
  ([8cdbfde](https://github.com/artk0de/TeaRAGs-MCP/commit/8cdbfdec91271221334586585a75b82d13d235ba))
- **scripts:** Cursor harness package generated from the plugin sources (manual
  test handed over)
  ([a45ea72](https://github.com/artk0de/TeaRAGs-MCP/commit/a45ea725a533dcea97d7f649ca1d2f34bad2339b))
- **scripts:** Rust residual taxonomy over chain-tally residual rows (s3i8m.1)
  ([7dba306](https://github.com/artk0de/TeaRAGs-MCP/commit/7dba306f1cf2d996bc6dabc0c348818313aae345))
- **trajectory:** Rust calls record their member token and SCIP defs their names
  (s3i8m.6 R3-1)
  ([3053436](https://github.com/artk0de/TeaRAGs-MCP/commit/30534369a799a8a7bb2e5d20447b091e212cf9fe))
- **trajectory:** Rust external signature sources, cache and resolve wiring
  (s3i8m.7 T2)
  ([172f0c8](https://github.com/artk0de/TeaRAGs-MCP/commit/172f0c81b2c3e9a2eebbcceeaebe14b713025913))
- **trajectory:** Rust external signature table extractor (s3i8m.7 T1)
  ([b0d5640](https://github.com/artk0de/TeaRAGs-MCP/commit/b0d5640da243a3059b53428c91b698f7157b0814))
- **trajectory:** Rust signature table carries free functions and tuple returns
  (s3i8m.7 T-A1)
  ([887a4ea](https://github.com/artk0de/TeaRAGs-MCP/commit/887a4ea52c62d72206e5239abc5537637f70c8c5))
- **trajectory:** rust-analyzer discovery, install hint and env flags (s3i8m.6
  R1)
  ([9088605](https://github.com/artk0de/TeaRAGs-MCP/commit/90886058e33e8491e8eaf1caf2c413f78f88453d))
- **trajectory:** rust-analyzer SCIP answers the Rust chain's residual call
  sites (s3i8m.6 R3a)
  ([6abfbd3](https://github.com/artk0de/TeaRAGs-MCP/commit/6abfbd3b466d62f18a4078f5cb3ccd70e1077069))
- **trajectory:** rust-analyzer SCIP runner and decoder (s3i8m.6 R2a)
  ([e89700b](https://github.com/artk0de/TeaRAGs-MCP/commit/e89700b60fdd941cde3287cb8a16c5e71280341f))
- **trajectory:** rust-analyzer SCIP warms ahead of the Rust resolve pass
  (s3i8m.6 R2b-1)
  ([89593b9](https://github.com/artk0de/TeaRAGs-MCP/commit/89593b99daff41ae929f498975b53738aa97656b)),
  closes
  [CallEdgeResolutionRunner#warmResolvePass](https://github.com/artk0de/CallEdgeResolutionRunner/issues/warmResolvePass)
  [GraphBuildFinalizer#resolveAndUpsert](https://github.com/artk0de/GraphBuildFinalizer/issues/resolveAndUpsert)
- **trajectory:** rustc call-site port and driver slot before SCIP (s3i8m T6/T7)
  ([bbefe91](https://github.com/artk0de/TeaRAGs-MCP/commit/bbefe916a275c57440ccf6acfbf37fb88d69d5b0))
- **trajectory:** say Rust call edges are static-only when the rustc driver is
  unavailable
  ([a06a406](https://github.com/artk0de/TeaRAGs-MCP/commit/a06a4065554749f05d1e2ed3eb2eb265b22f25c6))
- **trajectory:** SCIP-proven Rust types and locals are no in-project definition
  (s3i8m.6 R3b)
  ([634b157](https://github.com/artk0de/TeaRAGs-MCP/commit/634b1571e32e653fd8880bd0fae523870ff5e085))
- **trajectory:** surface rust-analyzer install hint in index, prime and status
  (s3i8m.6)
  ([8f292ae](https://github.com/artk0de/TeaRAGs-MCP/commit/8f292ae162977b9a8f0db49fa96369e5f4cce090))

### Improvements

- **adapters:** run the rustc driver on warm incremental passes, skip cargo when
  idle
  ([a0b6066](https://github.com/artk0de/TeaRAGs-MCP/commit/a0b6066782a97b39417871235ba8a2e2a815b88d))
- **api:** answer banner also leads structuredContent as its first key (nknkg.3)
  ([29ff355](https://github.com/artk0de/TeaRAGs-MCP/commit/29ff35568676096756a53ad3877802ba926951ec))
- **api:** banner fires only for pending files; drop live/graph-edges text
  (u7afw)
  ([1aa052f](https://github.com/artk0de/TeaRAGs-MCP/commit/1aa052f3acf5f0554eec484b71751f37122bbc99))
- **api:** lagging answers open with a "served live" working-tree banner (u7afw)
  ([09de0cf](https://github.com/artk0de/TeaRAGs-MCP/commit/09de0cff332fb551a260ce6925edf6bff8e6a5bb))
- **api:** point tool hints at the canonical tea-rags://guide/\* URIs
  ([2542db7](https://github.com/artk0de/TeaRAGs-MCP/commit/2542db72d956bcd4b042ab28cf7336690d1e0bca))
- **api:** read answers drop drift, next hints and the clean workingTree marker
  (icujw, 68jud)
  ([12acdec](https://github.com/artk0de/TeaRAGs-MCP/commit/12acdecf1f2ea7ef1d80f8441a30c2deda734927))
- **api:** review_changes lists unjudged files once, grouped by reason (56fax)
  ([ce4aa74](https://github.com/artk0de/TeaRAGs-MCP/commit/ce4aa746d53a487cb9b9a6b5a9bbb3479553327b))
- **api:** suggest near-miss payload keys in fieldsWarning
  ([d38ea26](https://github.com/artk0de/TeaRAGs-MCP/commit/d38ea26ce92719c97b39d582112dcf8846fe0ef3))
- **api:** template find_co_changed drill hints so the report hoists them
  ([ddbb204](https://github.com/artk0de/TeaRAGs-MCP/commit/ddbb204b49b5f4eafc78f343d4da244429737abc))
- **api:** trim search-tool hints and find_symbol description (schema lane V1,
  9f0yn.6)
  ([317656b](https://github.com/artk0de/TeaRAGs-MCP/commit/317656b2b2aaf818c2ea6e5508c177b0ed18569a))
- **chunker:** Ruby header blocks carry the leading comment and one-line nested
  classes
  ([08a9fd3](https://github.com/artk0de/TeaRAGs-MCP/commit/08a9fd37af38fe19109110f904f2eef6807bec5b))
- **chunker:** Ruby leaf chunks carry their leading comment; header block keeps
  end rows
  ([b5d0bd4](https://github.com/artk0de/TeaRAGs-MCP/commit/b5d0bd4f93cf059c4bc5d1c7c91f25ed69b9ac5d)),
  closes [#part1](https://github.com/artk0de/TeaRAGs-MCP/issues/part1)
- **cli:** collapse multi-URL embedding failures in prime infra line (q1g6s.3)
  ([41e9c84](https://github.com/artk0de/TeaRAGs-MCP/commit/41e9c84b34081b9c685ac8828e6aafab187c64bc))
- **cli:** doctor --footprints --fix clears store leftovers in one batch (expwb)
  ([0e1b614](https://github.com/artk0de/TeaRAGs-MCP/commit/0e1b614e3c914ef894cdd988cf27b563119891e4)),
  closes
  [CollectionFootprintPurger#purgeStoreLeftovers](https://github.com/artk0de/CollectionFootprintPurger/issues/purgeStoreLeftovers)
  [SnapshotArtifact#remove](https://github.com/artk0de/SnapshotArtifact/issues/remove)
- **dx:** a DSL name (ns:task) routes to find_symbol from core; Rake eval cases
  (k0602)
  ([b00c233](https://github.com/artk0de/TeaRAGs-MCP/commit/b00c233f72ec52b3745e432d163075147797c538))
- **dx:** a find_symbol batch carries member ids, never file/dir paths (yz10n)
  ([db40fc3](https://github.com/artk0de/TeaRAGs-MCP/commit/db40fc3383a5343719e95ecedf9a6c0e62e57627))
- **dx:** agent digest drops codegraph line; tool list is the signal
  ([23f5354](https://github.com/artk0de/TeaRAGs-MCP/commit/23f5354d1f5255d605e356c06732fc309f3144ba))
- **dx:** agent digest keeps addressing, codegraph-off and actionable freshness
  (nknkg.1)
  ([1b16af6](https://github.com/artk0de/TeaRAGs-MCP/commit/1b16af65b7e35b6db9d6186f446bbef910e8ad76))
- **dx:** bound occurrence searches and ban shell reads of indexed code (urs4z)
  ([e7b24fb](https://github.com/artk0de/TeaRAGs-MCP/commit/e7b24fb0b1cf47f98059a28ba88fc200c011c79e))
- **dx:** bounded Codex text search and default code search/read tool terms
  (urs4z)
  ([0ed62eb](https://github.com/artk0de/TeaRAGs-MCP/commit/0ed62eb4de16748c49f23e4d96f5d803c7d32538))
- **dx:** bug-hunt, DDG and mr-review read named ids in ONE find_symbol(symbols)
  (1k059)
  ([2a79d5a](https://github.com/artk0de/TeaRAGs-MCP/commit/2a79d5afd31dbf1357cedfb6d16b82b2c0126151))
- **dx:** Codex core says $tea-rags-core IS this text — no SKILL.md re-read;
  core hook budget 9650 (q1g6s.9)
  ([9298396](https://github.com/artk0de/TeaRAGs-MCP/commit/92983963dc2248e66322520b9f11dc7d67322e04))
- **dx:** concept alternations route to semantic_search, not text search (c9aft)
  ([b399790](https://github.com/artk0de/TeaRAGs-MCP/commit/b39979079dee8f447ff74be8ccfa7a208bcb8cdd))
- **dx:** core carries the research Question -> call rows; core cap 7700 -> 8100
  (q1g6s.8)
  ([8c63f22](https://github.com/artk0de/TeaRAGs-MCP/commit/8c63f225eb67a87245f6a3609fc657e03c2fc172))
- **dx:** core honours digest 'codegraph off'; injection caps raised (nknkg.1)
  ([9fbda41](https://github.com/artk0de/TeaRAGs-MCP/commit/9fbda419394cb79d8fa9adfc9dd323a5635eaa49))
- **dx:** core opens with the all-code-via-tea-rags rule, batch drill literal,
  decision-tree Question -> call table; Codex core and digest ride separate
  SessionStart hooks (q1g6s.2)
  ([f85cbd1](https://github.com/artk0de/TeaRAGs-MCP/commit/f85cbd10cb3f4f5a9a8559f53d625b1d7c5be66b))
- **dx:** core row 1 routes "how does <dir> work" path-first (afdpc)
  ([65b23af](https://github.com/artk0de/TeaRAGs-MCP/commit/65b23af8dce7d7c7e000f612494617389b76baab))
- **dx:** core teaches multi-query 'a ||| b' in one semantic_search (2vuz)
  ([2871a31](https://github.com/artk0de/TeaRAGs-MCP/commit/2871a31032dea5a8c8618abb2f7db02614aa1604))
- **dx:** core trusts context and a clean index; Codex rules own hook (q1g6s.14)
  ([a6721e2](https://github.com/artk0de/TeaRAGs-MCP/commit/a6721e2eb0b26936ec851f18e556f82eee2c5299))
- **dx:** DDG Step 7 risk call survives in-context labels; copy-safe mr-review
  MAP line (1k059)
  ([aa2953b](https://github.com/artk0de/TeaRAGs-MCP/commit/aa2953b516f83c5d4b341743999cac4f8e22e6ee))
- **dx:** dinopowers wrappers read several named ids in one find_symbol batch
  (1k059)
  ([95ede00](https://github.com/artk0de/TeaRAGs-MCP/commit/95ede00434924c58f07af322cb5584d2c805d5c8))
- **dx:** exact-name occurrences route to the client's standard code search tool
  (q1g6s.17)
  ([1cc549b](https://github.com/artk0de/TeaRAGs-MCP/commit/1cc549b363576f2245c40b0fdb8ee9b8b2ad71af))
- **dx:** explore follows an anchor row into the graph on flow words (nknkg.3)
  ([c21024a](https://github.com/artk0de/TeaRAGs-MCP/commit/c21024aa0dee4bad5b435810abc79867f2258ac2))
- **dx:** graph-first navigation in core — symbolId edges from search rows, read
  named bodies not files (q1g6s.14)
  ([de99b85](https://github.com/artk0de/TeaRAGs-MCP/commit/de99b85f9261ea22d59a3dacc5b71a9678c316b1))
- **dx:** occurrence hits are read and every-caller asks plan both calls (0jt47)
  ([58d440c](https://github.com/artk0de/TeaRAGs-MCP/commit/58d440cf64ca907d4594603cc30b0b9bcef6eee6))
- **dx:** plugin text follows status-only drift and the indexed-read deny hook
  (0jt47)
  ([ece53e2](https://github.com/artk0de/TeaRAGs-MCP/commit/ece53e2e95c53889e07875921d62aaa63775589d)),
  closes [Class#member](https://github.com/artk0de/Class/issues/member)
- **dx:** route flow and impact questions to depth-2 call trees (afdpc)
  ([ec5dac1](https://github.com/artk0de/TeaRAGs-MCP/commit/ec5dac1f4fb9430d35d1fd75e85d8efca5590f03))
- **dx:** typed directory path routes path-first before explore row 4 (afdpc)
  ([7914d3d](https://github.com/artk0de/TeaRAGs-MCP/commit/7914d3dd82785d0f88c5f07d8087e4464cb96199))
- **dx:** writing-plans reads a named
  Class[#method](https://github.com/artk0de/TeaRAGs-MCP/issues/method) as its
  id, no outline call first (1k059)
  ([ed3660d](https://github.com/artk0de/TeaRAGs-MCP/commit/ed3660df68197a5dd4ba799e9d5caf0b00111d93))
- **embedding:** size llama-server slots from the GGUF context window
  ([a29a91f](https://github.com/artk0de/TeaRAGs-MCP/commit/a29a91fa9829c889bba420c859c72d86faa6bac8))
- **explore:** always-on core shrinks to one part; navigation, freshness and
  decision-tree guides move behind tea-rags://guide/\*
  ([4a323de](https://github.com/artk0de/TeaRAGs-MCP/commit/4a323decf77644bc026fd2b8b2fef3c37ed53ece))
- **explore:** an ambiguous find_symbol batch address lists its candidates
  (d9w4o)
  ([b6a22f0](https://github.com/artk0de/TeaRAGs-MCP/commit/b6a22f07a1a40def2b23838dbebdef7d7bbb6979))
- **explore:** architecture-diagnostics — Phase 1/3b–3i/4 and anti-patterns to
  references (69444→13642 bytes)
  ([3abbc7b](https://github.com/artk0de/TeaRAGs-MCP/commit/3abbc7b0578886ff2725ae1cceb553fcd1001c6a))
- **explore:** batch path entries answer full text up to 150 lines within a char
  budget (yz10n)
  ([881a1a7](https://github.com/artk0de/TeaRAGs-MCP/commit/881a1a7c1f101d0c67996e5bd90071d2b2d409f9)),
  closes
  [FileOutlineStrategy#outlineBehindFullText](https://github.com/artk0de/FileOutlineStrategy/issues/outlineBehindFullText)
- **explore:** callees-first anchor hints, skip tests, find_symbol next
  (q1g6s.2)
  ([976a51b](https://github.com/artk0de/TeaRAGs-MCP/commit/976a51b9bd0a47796926bb4627405f8f4162d19a)),
  closes
  [ExploreOps#findSymbol](https://github.com/artk0de/ExploreOps/issues/findSymbol)
- **explore:** class outline lists ancestors as drillable ids (82cot)
  ([636ef4b](https://github.com/artk0de/TeaRAGs-MCP/commit/636ef4bfb089a872918848f7357f3319cd83f530)),
  closes
  [GraphDbClient#getSupertypes](https://github.com/artk0de/GraphDbClient/issues/getSupertypes)
- **explore:** data-consuming skills read project metrics and guides via
  resources
  ([9a1f7fb](https://github.com/artk0de/TeaRAGs-MCP/commit/9a1f7fb3d71f31bd7d9342e153aeae3c9031a987))
- **explore:** data-driven-generation — Steps 5–7 to references, labels via
  metrics resource (33624→12675 bytes)
  ([d09be8b](https://github.com/artk0de/TeaRAGs-MCP/commit/d09be8b3d641298eabbb3964c682118c5f628335))
- **explore:** dinopowers skills — dead weight out, call-route reference split,
  project data via resources (150,158→115,918 bytes)
  ([f4114c7](https://github.com/artk0de/TeaRAGs-MCP/commit/f4114c70ee2df61be12833bf85e030db504e4a6e))
- **explore:** find_symbol on a class id answers its header chunks with the
  outline
  ([42d83c8](https://github.com/artk0de/TeaRAGs-MCP/commit/42d83c834b3de7f2005995abf98914b1abde72b6))
- **explore:** find_symbol symbols batch dispatches table:/migration: addresses
  (7dcty.2)
  ([8d1364b](https://github.com/artk0de/TeaRAGs-MCP/commit/8d1364b3225958e2c1824d88aa1a2580b7ff03e3)),
  closes
  [ExploreOps#findMigrationSymbol](https://github.com/artk0de/ExploreOps/issues/findMigrationSymbol)
- **explore:** one inlined-text budget per find_symbol answer
  ([b0e082c](https://github.com/artk0de/TeaRAGs-MCP/commit/b0e082cc746a2e9ec8d4fb591dca6a20bc4fff08))
- **explore:** outline member lines carry their line range
  ([2b92ef1](https://github.com/artk0de/TeaRAGs-MCP/commit/2b92ef150117de03595d0ad4b0cd31f303b24385)),
  closes [X#m](https://github.com/artk0de/X/issues/m)
- **explore:** prime prints the slim project digest; --full keeps thresholds for
  humans
  ([2b408d4](https://github.com/artk0de/TeaRAGs-MCP/commit/2b408d4c251601a022f194c4ee628a2ebd93c5d0))
- **explore:** remaining tea-rags skills + rules/references — dead weight out,
  project data via resources (177,821→149,357 bytes)
  ([9bd5791](https://github.com/artk0de/TeaRAGs-MCP/commit/9bd57916564bcd017d497cd18da971da40d3d837))
- **explore:** risk-assessment — Phase 4 ENRICH to references, project data via
  resources (27368→19783 bytes)
  ([7be02c4](https://github.com/artk0de/TeaRAGs-MCP/commit/7be02c4de8ab7e69d6a84ddcde0e6b2040ffb3b7))
- **explore:** taskId search rows keep the matched taskIds in the default
  projection (d9w4o)
  ([7819f69](https://github.com/artk0de/TeaRAGs-MCP/commit/7819f69d0e9b4c2f799fef06c12ad23677e12372))
- **explore:** tea-rags-setup skills — dead weight out, freshness step points at
  digest resource (49,592→45,255 bytes)
  ([9673ee3](https://github.com/artk0de/TeaRAGs-MCP/commit/9673ee34778154958f937d9c9c1a53cc4b707c49))
- **ingest:** languages declare their own ignore contributions; prune vendored
  suites by marker
  ([2c3a081](https://github.com/artk0de/TeaRAGs-MCP/commit/2c3a081713b171fc5996630a31119ff3e3726c83))
- **mcp:** move answer-reading prose to guides, compact rerank custom arm and
  address hints
  ([d989b93](https://github.com/artk0de/TeaRAGs-MCP/commit/d989b93d67f7efc544fd85eff6407828f441e082)),
  closes
  [SchemaBuilder#customWeightSignals](https://github.com/artk0de/SchemaBuilder/issues/customWeightSignals)
- **mcp:** schema and resources say project = index, path = tree (55u9i)
  ([7c6bb58](https://github.com/artk0de/TeaRAGs-MCP/commit/7c6bb584957ce82995181c5047d5cd5fcd8f00d6))
- **mcp:** schema/\* aliases become one unlisted template; listing budget counts
  templates
  ([b432ad6](https://github.com/artk0de/TeaRAGs-MCP/commit/b432ad6e5f0db2f6f74a0f7fa60841992aab114f))
- **mcp:** surface the rustc driver line in index, status, prime and CLI output
  (s3i8m T9)
  ([4e7714b](https://github.com/artk0de/TeaRAGs-MCP/commit/4e7714b9d098afe840e320d343603897630d3c2e))
- **plugins:** cheaper Codex sessions — explore split, narrower skill triggers
  (paae3)
  ([7046434](https://github.com/artk0de/TeaRAGs-MCP/commit/7046434bebb4dee8481972bae1c1f55812f193c5))
- **plugins:** decision-tree split into topic guides (lqyop)
  ([3136416](https://github.com/artk0de/TeaRAGs-MCP/commit/3136416405fd788c7cec51ff2393793b4687129c))
- **plugins:** leaner core — redundancy cut, Codex usages scoped to source dir
  (nknkg.4, 5xbfc)
  ([e68f8ea](https://github.com/artk0de/TeaRAGs-MCP/commit/e68f8eab964aed84ada2f9e0cc18fdb6e4fe8a09))
- **plugins:** routing fixes for HD1/N5/BR2 + usages dir examples (5xbfc)
  ([ba38a37](https://github.com/artk0de/TeaRAGs-MCP/commit/ba38a37377d5b1f02725cc9cfca3dcea96cd8ca2))
- **plugins:** split heavy skills into on-demand references (paae3)
  ([883bf90](https://github.com/artk0de/TeaRAGs-MCP/commit/883bf90cbc5930efdd22f4ef97dca28bcd5b719d))
- **scripts:** Claude core names the Bash grep fallback and zsh-safe globs once
  ([4de409d](https://github.com/artk0de/TeaRAGs-MCP/commit/4de409d46e1a039e1f91a9c72fce823a6369636b))
- **scripts:** subagent block under 3KB; dinopowers routing injected once per
  session
  ([66c4115](https://github.com/artk0de/TeaRAGs-MCP/commit/66c411559bcf7f5cf7ca94174742c821c3991b33))
- **setup:** install branch for this Mac as the llama-server embedding host
  ([6d1ced9](https://github.com/artk0de/TeaRAGs-MCP/commit/6d1ced9a3f9922b1e7921270d2d73628d72b65a4))
- **trajectory:** a later Rust receiver binding wins across local and
  call-result lets (s3i8m)
  ([556f2cd](https://github.com/artk0de/TeaRAGs-MCP/commit/556f2cd93fa65b7e29502654e0715b2068b12dbf)),
  closes [BodySink#take](https://github.com/artk0de/BodySink/issues/take)
- **trajectory:** count driver-proven workspace defs with no source external
  ([5539aab](https://github.com/artk0de/TeaRAGs-MCP/commit/5539aabc3349f7910d0fa42237415a4871457338))
- **trajectory:** count external-trait declaration rows external, not
  undecidable
  ([a8193dd](https://github.com/artk0de/TeaRAGs-MCP/commit/a8193dd1b35b1fbaf12dff220bc22d438623e7d7))
- **trajectory:** count external-trait declaration rows undecidable
  ([9040007](https://github.com/artk0de/TeaRAGs-MCP/commit/90400078d38a1551f558e58fef7f76347040af94))
- **trajectory:** drop name-only std-prelude bindings where the rustc driver is
  silent
  ([ad1ea98](https://github.com/artk0de/TeaRAGs-MCP/commit/ad1ea98ce85c9b5bcf2953b488e2244c62016dce))
- **trajectory:** edge project-macro-generated trait impls to the project trait
  method
  ([de1e1fd](https://github.com/artk0de/TeaRAGs-MCP/commit/de1e1fdb982a3f52dd8bbd393d6e6f5d44051af0))
- **trajectory:** make the rustc driver row authoritative over the Rust static
  chain
  ([2ab4708](https://github.com/artk0de/TeaRAGs-MCP/commit/2ab470858f04e9f79d8c287e2d908f40ceec3965))
- **trajectory:** persist the rustc driver status per codegraph run for status
  and prime
  ([db4a7f6](https://github.com/artk0de/TeaRAGs-MCP/commit/db4a7f6d6423a2ef68c51a34255f39b6781fb27a))
- **trajectory:** place re-exported Rust Result aliases and drop std methods on
  typed misses
  ([d1ab07c](https://github.com/artk0de/TeaRAGs-MCP/commit/d1ab07c683d85b4822e496387535dac853a1b5e9))
- **trajectory:** place Rust item paths through the crate module system
  ([a29c8fb](https://github.com/artk0de/TeaRAGs-MCP/commit/a29c8fbfe9c1db2acb5af8ba1b53d88a4fb2fbcc))
- **trajectory:** read Rust declaring-file imports past unparsed globs
  ([49f9330](https://github.com/artk0de/TeaRAGs-MCP/commit/49f9330fde2f1e336a5ef0a1f6aaf736b25f7d4b))
- **trajectory:** resolve Rust bare calls through their lexical scope
  ([14d457d](https://github.com/artk0de/TeaRAGs-MCP/commit/14d457d40abbfa44e4b504b762d8c93014993c97))
- **trajectory:** Rust call-result bindings gate per name, block scoping,
  shadowing (2g2og.24 S1)
  ([8bb9992](https://github.com/artk0de/TeaRAGs-MCP/commit/8bb99924c4b9cd35fe20eb5b238e0c1a6db8e793)),
  closes
  [Document#selection](https://github.com/artk0de/Document/issues/selection)
- **trajectory:** Rust call-result locals stay typed outside a pattern that
  rebinds them (s3i8m)
  ([c9a59a1](https://github.com/artk0de/TeaRAGs-MCP/commit/c9a59a1c7d0efebd8bad1e647bfc83da372317ff))
- **trajectory:** Rust concrete-type member lookup and std-type terminal
  classification (s3i8m.3)
  ([c952ef7](https://github.com/artk0de/TeaRAGs-MCP/commit/c952ef7d9fd172bc811ed5ed454448717eb850b9))
- **trajectory:** Rust crate map honours dependency renames and [lib] name
  (sjego)
  ([2e3da41](https://github.com/artk0de/TeaRAGs-MCP/commit/2e3da41f1d861b82fa78cdbfb7bd0ff716119e44))
- **trajectory:** Rust crate-scoped cross-file impl members (s3i8m Task 2 rules
  1-4)
  ([0f11df4](https://github.com/artk0de/TeaRAGs-MCP/commit/0f11df4746825a75e872ff4a6665bbc05140dd78)),
  closes [T#m](https://github.com/artk0de/T/issues/m)
  [HashMapTracedValues#get_mut](https://github.com/artk0de/HashMapTracedValues/issues/get_mut)
- **trajectory:** Rust destructured table tuple vetoes only the shadowed element
  (s3i8m.7 T-A2)
  ([c8a68ff](https://github.com/artk0de/TeaRAGs-MCP/commit/c8a68ff2c71a5902e1b166b17b138fbf8b74e4d2))
- **trajectory:** Rust fields of std/dependency structs type the next hop
  (s3i8m.7 T3c)
  ([96dcf20](https://github.com/artk0de/TeaRAGs-MCP/commit/96dcf2090285ab3a7c77b19ccd5a0c47c27e0b99))
- **trajectory:** Rust lets bound from external free functions take table
  returns (s3i8m.7 T-A2)
  ([253f2bb](https://github.com/artk0de/TeaRAGs-MCP/commit/253f2bbde708a01d043e50e0a4b4b068caa7fca2))
- **trajectory:** Rust loop elements, closure params, variant payloads typed
  (s3i8m 1b)
  ([4c32d9d](https://github.com/artk0de/TeaRAGs-MCP/commit/4c32d9de424c80a39fea2347c598ed56cf0c02d8))
- **trajectory:** Rust path calls on std/dependency types take the table's
  return (s3i8m.7 T3c)
  ([e216c9b](https://github.com/artk0de/TeaRAGs-MCP/commit/e216c9b645b9c05526efcb808f1f665e9bfd7737))
- **trajectory:** Rust pattern bindings shadow and type
  Option/Result/tuple/field (s3i8m 1a)
  ([c1340d4](https://github.com/artk0de/TeaRAGs-MCP/commit/c1340d4daea08901aad4d2939356d41bf76eda36))
- **trajectory:** Rust per-file use imports reach the resolver (s3i8m letCall
  S4a)
  ([7855356](https://github.com/artk0de/TeaRAGs-MCP/commit/785535667d6747a29fcaa40eb140d4746f8a727e))
- **trajectory:** Rust receivers fold table member returns and Deref targets
  (s3i8m.7 T3b)
  ([cc3a924](https://github.com/artk0de/TeaRAGs-MCP/commit/cc3a9245e9ccf0da2fea7659b8a780db132cd76e))
- **trajectory:** Rust self-field and method-return chain typing (2g2og.24
  slice 1)
  ([09ed7d4](https://github.com/artk0de/TeaRAGs-MCP/commit/09ed7d41d0dbd5a63b5063dab0155e5fee64b628)),
  closes [Error#clone](https://github.com/artk0de/Error/issues/clone)
  [Glob#as_ref](https://github.com/artk0de/Glob/issues/as_ref)
  [ByteSet#remove](https://github.com/artk0de/ByteSet/issues/remove)
  [Stack#pop](https://github.com/artk0de/Stack/issues/pop)
  [Product#finish](https://github.com/artk0de/Product/issues/finish)
- **trajectory:** Rust std inherent members resolve from the signature table
  (s3i8m.7 T3)
  ([300c32c](https://github.com/artk0de/TeaRAGs-MCP/commit/300c32cf10b2ca71c773d59172ed90250d96fb82))
- **trajectory:** Rust std-trait members take the closed return model (s3i8m.7
  T3c)
  ([e56cb70](https://github.com/artk0de/TeaRAGs-MCP/commit/e56cb70e3f2d9e1b56aec7c2f9dc7a3f5d9aac1a))
- **trajectory:** Rust trait self-calls prove traits from generic Self bounds
  (s3i8m)
  ([95e32cb](https://github.com/artk0de/TeaRAGs-MCP/commit/95e32cbf5f1c2a4f753cdd7d28910492c7f6f608))
- **trajectory:** Rust trait-provided self.m() reaches the trait (s3i8m Task 2
  rule 5)
  ([81c8dce](https://github.com/artk0de/TeaRAGs-MCP/commit/81c8dcef813a1a56f4b3d2ba2395411b993bae7b))
- **trajectory:** Rust types place through the declaring file's imports (s3i8m
  letCall S4b)
  ([6939bb2](https://github.com/artk0de/TeaRAGs-MCP/commit/6939bb24194b67e0ba714ad75b36abec77d7b499))
- **trajectory:** Rust workspace crate names map to member directories (sjego)
  ([20fb08e](https://github.com/artk0de/TeaRAGs-MCP/commit/20fb08e8fcd4e1ede187d1dc9f8f6677e6119b79))
- **trajectory:** type assoc-fn chain heads and call-result inits for Rust
  receivers
  ([d0573f5](https://github.com/artk0de/TeaRAGs-MCP/commit/d0573f55a6720b3855897242552cddf63f51b095))
- **trajectory:** type reassigned, if-initialized and \*self Rust locals in the
  walker
  ([b2f7efc](https://github.com/artk0de/TeaRAGs-MCP/commit/b2f7efc3e26ad33836c1ff40ff983f9f52855e98))

### Bug Fixes

- **adapters:** do not latch an all-failed rustc-driver run that failed on
  offline cargo fetch
  ([f2b1490](https://github.com/artk0de/TeaRAGs-MCP/commit/f2b149054475906310fdff7a86ac404276e8e0c3))
- **adapters:** keep a trait's crate external when its method resolves to a
  project impl
  ([1c706ca](https://github.com/artk0de/TeaRAGs-MCP/commit/1c706ca347442bb623a9e9be56c28ea66594ced4))
- **adapters:** keep prettier off vendored crates of the rustc driver
  ([6c92045](https://github.com/artk0de/TeaRAGs-MCP/commit/6c92045dbe94d2f10f12e30189b04750890796af))
- **adapters:** keep rustc driver build-script units and name stderr-only
  failures
  ([5b1f105](https://github.com/artk0de/TeaRAGs-MCP/commit/5b1f105a4a97552abcea44ccd05adc2846b81957))
- **adapters:** lapse the allUnitsFailed rustc-driver latch when a Rust source
  changes
  ([f69e366](https://github.com/artk0de/TeaRAGs-MCP/commit/f69e3667f25109a960128e85a719962704cb3bd8))
- **adapters:** one rustc-driver dir per project, envKey as a run-record field
  (tea-rags-mcp-rw6ul)
  ([b0e3e1a](https://github.com/artk0de/TeaRAGs-MCP/commit/b0e3e1ad604d3ccf3e990c3da904f4520fc05a15))
- **adapters:** re-run cargo under reuseOnly when a crate that failed last run
  was edited
  ([c3b0832](https://github.com/artk0de/TeaRAGs-MCP/commit/c3b08329b68f303bb29a63c85cece91428f04699))
- **adapters:** retire legacy rustc-driver env dirs off the acquisition path
  (tea-rags-mcp-rw6ul)
  ([3d22a06](https://github.com/artk0de/TeaRAGs-MCP/commit/3d22a0667ee39092193ee37927865ff8be406d71))
- **adapters:** walk keeps model file edges; edge target index rebuilt after
  sync (m7png)
  ([fa30161](https://github.com/artk0de/TeaRAGs-MCP/commit/fa301615473b5a708ddb9056e542b3e98c4af6fe)),
  closes
  [DuckDbGraphSession#applyScopedRowDiff](https://github.com/artk0de/DuckDbGraphSession/issues/applyScopedRowDiff)
  [DuckDbFileGraphStore#writeFileRowsGroup](https://github.com/artk0de/DuckDbFileGraphStore/issues/writeFileRowsGroup)
  [DuckDbResidualEdgeStore#applyModelEdges](https://github.com/artk0de/DuckDbResidualEdgeStore/issues/applyModelEdges)
  [DuckDbStorageMaintenance#rebuildEdgeFileTargetIndex](https://github.com/artk0de/DuckDbStorageMaintenance/issues/rebuildEdgeFileTargetIndex)
  [GraphBuildFinalizer#checkpoint](https://github.com/artk0de/GraphBuildFinalizer/issues/checkpoint)
- **api:** a working tree the overlay fully served goes out as { tree, project }
  (q1g6s.15)
  ([e0e068b](https://github.com/artk0de/TeaRAGs-MCP/commit/e0e068b0525c9fdae91d3cfec6293dd4ca79d194))
- **api:** budget continuation keeps the requested limit window
  ([ba5cb46](https://github.com/artk0de/TeaRAGs-MCP/commit/ba5cb46d1b8bebedaa2f19316f8fb139e95e87d6))
- **api:** explainedPairCount reports every explained pair, not the capped list
  ([ce82adf](https://github.com/artk0de/TeaRAGs-MCP/commit/ce82adf0db2f9ee28f78513114db44c96c7421ec))
- **api:** find_symbol body banner only when every row is a body (nknkg.3)
  ([60906db](https://github.com/artk0de/TeaRAGs-MCP/commit/60906dbb932e867c6fb47eb2bd5a9189693ae078))
- **api:** get_callers / get_callees on a class or module roll up its members'
  edges (znzv3)
  ([774b2c7](https://github.com/artk0de/TeaRAGs-MCP/commit/774b2c7231fafa4234bbd400821c61865d58b398)),
  closes [C#m](https://github.com/artk0de/C/issues/m)
  [Adapter#call](https://github.com/artk0de/Adapter/issues/call)
- **api:** graph answers under tree lag wait 3 s, mark index edges, never
  silently empty (07b9w)
  ([9945f9d](https://github.com/artk0de/TeaRAGs-MCP/commit/9945f9d57cefe0dec48adfab9ab5d7a6242532f0))
- **api:** Rust graph answers carry the rustc-driver lower-bound notice
  (nknkg.1)
  ([5f29e59](https://github.com/artk0de/TeaRAGs-MCP/commit/5f29e592379b4b85b355fa4ee9a40bc8a5864d97))
- **api:** treeGraphUnavailable says queued, not building, behind another build
  (ewg7d)
  ([35e1cf7](https://github.com/artk0de/TeaRAGs-MCP/commit/35e1cf77ce4e308f86d4cfb64ef6c999b71bac9d)),
  closes
  [WorkingTreeGraphProcessBuilder#build](https://github.com/artk0de/WorkingTreeGraphProcessBuilder/issues/build)
- **api:** trim architecture report summary lists to evidenceLimit
  ([38d2eab](https://github.com/artk0de/TeaRAGs-MCP/commit/38d2eab74facea4b9673d33fe0e0c1ff6a0e0d59))
- **bootstrap:** indexed-file query goes through a core/api entry point (ueplg)
  ([d9c10da](https://github.com/artk0de/TeaRAGs-MCP/commit/d9c10dae0b6c88139c88a7642a5d57f1bce824b1))
- **bootstrap:** prime resolves a linked worktree to its repo's base index
  (sx13r)
  ([8dc3901](https://github.com/artk0de/TeaRAGs-MCP/commit/8dc3901406a4f24851668a8d395490042dface09))
- **chunker:** a non-blank documentation file never yields zero chunks (6xdwe)
  ([b19e041](https://github.com/artk0de/TeaRAGs-MCP/commit/b19e041fdd635e1da49ec5e45d6da2a956124cd7))
- **chunker:** a non-blank file never yields zero chunks (6xdwe)
  ([16bac78](https://github.com/artk0de/TeaRAGs-MCP/commit/16bac78a0714e4bb9c311abf5f6f517cb3ab4219))
- **chunker:** chunk nested Ruby classes under their full id and address class
  constants (1x85g)
  ([aa8f1fd](https://github.com/artk0de/TeaRAGs-MCP/commit/aa8f1fd2cafd11ee630d87611fbec5fb439c095b))
- **chunker:** every row has one owning chunk (5ndal, 0k8zt)
  ([87e50ef](https://github.com/artk0de/TeaRAGs-MCP/commit/87e50efc77a438b086db289f253595a2c5379f01)),
  closes
  [TreeSitterChunker#computeEndLine](https://github.com/artk0de/TreeSitterChunker/issues/computeEndLine)
- **chunker:** keep every Ruby header-chunk fold inside its container-row run
  ([03d239b](https://github.com/artk0de/TeaRAGs-MCP/commit/03d239b6f887d933fbd65decc5a3a786b0b75e3d))
- **chunker:** module remainder covers top-level blocks, ambient modules, const
  headers (mpen8)
  ([4c00bd2](https://github.com/artk0de/TeaRAGs-MCP/commit/4c00bd2d0d4886779aaf005938c8aedba24c8ea4)),
  closes
  [TreeSitterChunker#unownedRows](https://github.com/artk0de/TreeSitterChunker/issues/unownedRows)
- **chunker:** nested Ruby value-class containers keep their own span and header
  (mfnvp)
  ([4fd423c](https://github.com/artk0de/TeaRAGs-MCP/commit/4fd423cf2ad181d1cc21d9854502981357fc928f)),
  closes
  [Row#read*attribute_for*](https://github.com/artk0de/Row/issues/read_attribute_for_)
- **chunker:** no Ruby class-body row in no chunk; short defs addressable
  (30qdc)
  ([d752cb6](https://github.com/artk0de/TeaRAGs-MCP/commit/d752cb6667a4a5b110b6f6ee514375b1b1ab118a))
- **chunker:** no TypeScript class-body row in no chunk; short methods
  addressable (xiki8)
  ([2ba07d4](https://github.com/artk0de/TeaRAGs-MCP/commit/2ba07d41cc1cd999c028e2b382580bdbe8d89c48)),
  closes [Owner#m](https://github.com/artk0de/Owner/issues/m)
- **chunker:** Rails migration chunks descend into block wrappers (m2h8f)
  ([eb90a6c](https://github.com/artk0de/TeaRAGs-MCP/commit/eb90a6c45624f6c3969d291c3d1e26800ea67b65))
- **chunker:** Ruby Data.define/Struct.new block bodies fully covered (0td4h)
  ([944c746](https://github.com/artk0de/TeaRAGs-MCP/commit/944c746fc70801aaeae706af4bf1bb4569ea7dce))
- **chunker:** Ruby header chunks follow container-row runs, never span a method
  ([4fbfb37](https://github.com/artk0de/TeaRAGs-MCP/commit/4fbfb375464fbe0320141fabd2d016015b1167b0))
- **chunker:** TS class body covers field groups, arrow members and split tails
  (gkvvo)
  ([121983c](https://github.com/artk0de/TeaRAGs-MCP/commit/121983c38f1bbe5741706a6cb696b88572923c0b))
- **cli:** doctor --footprints types its qdrant dependency against the purge
  roles (expwb)
  ([0506b67](https://github.com/artk0de/TeaRAGs-MCP/commit/0506b6761470be939789c830feaaf65d079c79c7))
- **cli:** prime stops prescribing project over path
  ([f85992d](https://github.com/artk0de/TeaRAGs-MCP/commit/f85992ddd47a54381cec0b4b00844545da9857df))
- **codegraph:** a malformed client frame closes its connection, not the daemon
  (tea-rags-mcp-bobef)
  ([aecfd84](https://github.com/artk0de/TeaRAGs-MCP/commit/aecfd8494cf6d54f436a4c5bd4fa0ad1bd073ccb))
- **codegraph:** an unencodable daemon response answers its request with an
  error (tea-rags-mcp-2pu78)
  ([fcd4cfe](https://github.com/artk0de/TeaRAGs-MCP/commit/fcd4cfe3949d1bf99c636a44a94e2c204e2b2924))
- **codegraph:** daemon refs track the daemon pid and reset on start
  (tea-rags-mcp-s2vuj)
  ([d9e56a1](https://github.com/artk0de/TeaRAGs-MCP/commit/d9e56a1b2245bb053303a465a155f168c943ef2f))
- **codegraph:** find_symbol FQN fallback keeps the owner — no silent same-tail
  substitution (ll0s8)
  ([8d2d186](https://github.com/artk0de/TeaRAGs-MCP/commit/8d2d18622e0627afb9533acd6c0fa46435c5fd86)),
  closes
  [DuckDbSymbolStore#findSymbolChunk](https://github.com/artk0de/DuckDbSymbolStore/issues/findSymbolChunk)
- **codegraph:** reclaim interrupted storage-conversion export on purge (r1c0s)
  ([f6ed14a](https://github.com/artk0de/TeaRAGs-MCP/commit/f6ed14ae3b15b16c3c12ed8bfedfa780ed51dfe7))
- **codegraph:** Ruby calls stop landing on unrelated project namesakes
  (q1g6s.10)
  ([c2ddb76](https://github.com/artk0de/TeaRAGs-MCP/commit/c2ddb7615519ebab9b834f4913c5ec68deea998b)),
  closes [#x](https://github.com/artk0de/TeaRAGs-MCP/issues/x)
  [Worker#name](https://github.com/artk0de/Worker/issues/name)
  [#perform](https://github.com/artk0de/TeaRAGs-MCP/issues/perform)
  [#perform_operation](https://github.com/artk0de/TeaRAGs-MCP/issues/perform_operation)
- **codegraph:** TS implements edges resolve project interfaces (3otbo)
  ([cb0010d](https://github.com/artk0de/TeaRAGs-MCP/commit/cb0010d430d68e5df98f16356c37ae1cfdcd67cb))
- **codex:** label every plugin hook in the UI
  ([1d4c4ac](https://github.com/artk0de/TeaRAGs-MCP/commit/1d4c4ac600e813c8adf8e0ee61a316e5411068c0))
- **codex:** record native shell output in read ledger
  ([f4e15bd](https://github.com/artk0de/TeaRAGs-MCP/commit/f4e15bd4842ad2434ae72da1364ee759aa122835))
- **codex:** retain enclosing route scope in bounded reads
  ([ec586e3](https://github.com/artk0de/TeaRAGs-MCP/commit/ec586e30ab23f250640e4143b6a8d0e961032c35))
- **codex:** schedule evidence reads without extra model steps
  ([cb9e373](https://github.com/artk0de/TeaRAGs-MCP/commit/cb9e37310936c5156bb51a2e0b15e1ace5843be9))
- **codex:** target missing evidence and batch context reads
  ([6b8fc3a](https://github.com/artk0de/TeaRAGs-MCP/commit/6b8fc3a72a276d80235a82a48aa96056500dfb1f))
- **dx:** a new user prompt resets search-drift counters, keeps the deny
  cooldown
  ([890459c](https://github.com/artk0de/TeaRAGs-MCP/commit/890459cdd16182eb3cc73b0072850fcdd8ff62b1))
- **dx:** close persistent Codex eval forks in DDG, test-first and routing
  skills
  ([30717a4](https://github.com/artk0de/TeaRAGs-MCP/commit/30717a45c3ea248ea040d4fb19bad2e54a404bd3))
- **dx:** close r27 Codex forks in DDG step 0/7, core consent order,
  verification grep
  ([4a5319e](https://github.com/artk0de/TeaRAGs-MCP/commit/4a5319e7df2e8a3d719cd24db6a5eae2341698f3))
- **dx:** close r45 eval slips in bug-hunt, wrappers, degraded and freshness
  guides
  ([83699cb](https://github.com/artk0de/TeaRAGs-MCP/commit/83699cb34c0d3b7ec6e6b72255cd753440b6f6e1))
- **dx:** close run-to-run forks behind T22 r34 Codex variance
  ([331f6e0](https://github.com/artk0de/TeaRAGs-MCP/commit/331f6e0ced8f1b08c5bc6537edf63a7b8f2c0a67))
- **dx:** close T22 r32 skill forks for Codex across tea-rags and dinopowers
  ([228797d](https://github.com/artk0de/TeaRAGs-MCP/commit/228797dbf9f39cc79b8dbe17ab6e2291e39c23be))
- **dx:** close T22 r33 skill forks and regressions for Codex
  ([c153148](https://github.com/artk0de/TeaRAGs-MCP/commit/c153148a08fa875c0287d0e661d571ba168dcbac))
- **dx:** close T22 r35 forks — core step-3 leak, routing triggers, literals
  ([08cb24a](https://github.com/artk0de/TeaRAGs-MCP/commit/08cb24aa1c0ce00fdd33553a0db725ec850478bf))
- **dx:** close T22 r36 forks — keep calls in outcome literals, say-it lines
  ([6e1859c](https://github.com/artk0de/TeaRAGs-MCP/commit/6e1859c9cadbbf33361e0f987f7f706bee31e938))
- **dx:** close T22 r38 forks — unskippable literals, scoped bans, core cap 3769
  ([cdf45f0](https://github.com/artk0de/TeaRAGs-MCP/commit/cdf45f0c0385dc958d41f01c3ce031c55f0a7a0f))
- **dx:** close T22 r40 forks — routing triggers, first-match row order,
  stateless eval fixtures
  ([5735709](https://github.com/artk0de/TeaRAGs-MCP/commit/57357093d80978465983ff0bb2e85b160d11e21e))
- **dx:** close T22 r41 forks — route-independent core literals, no-symptom
  symbol asks
  ([c0e32e4](https://github.com/artk0de/TeaRAGs-MCP/commit/c0e32e478b9a032823812cfe2147cb2338a8c012))
- **dx:** close T22 r42 forks — state-keyed SKIP override, count NOT-clauses,
  superpowers glob evidence
  ([aead0ee](https://github.com/artk0de/TeaRAGs-MCP/commit/aead0eeaef247dfeddb69bdbacf5f417cf510b04))
- **dx:** close T22 r43 forks — scoped rg literal, override in every SKIP copy,
  explicit codegraph evidence
  ([c45a177](https://github.com/artk0de/TeaRAGs-MCP/commit/c45a1773ae9bd8ae469f6acbdf624c3d6c26f25a))
- **dx:** close T22 r44 forks — explore-vs-plan routing, strategy-independent
  doc check, no planned worktree index
  ([3422130](https://github.com/artk0de/TeaRAGs-MCP/commit/34221305def1d2170580f3ccd7717938a926175f))
- **dx:** core cap 5000 → 6000 (Cursor .mdc 6400); literal phrase routes as a
  three-line plan
  ([4e5b1d4](https://github.com/artk0de/TeaRAGs-MCP/commit/4e5b1d4de5d5092f365d1f137e1a56ca717e598e))
- **dx:** core names the own-checkout incremental at graph-timeout re-checks
  ([49aa657](https://github.com/artk0de/TeaRAGs-MCP/commit/49aa6571bcd01f53a733e9218d1a00c3a3c65bed))
- **dx:** core prints the drift-consent line and runs step 1 before
  graph-timeout re-checks
  ([06e88d1](https://github.com/artk0de/TeaRAGs-MCP/commit/06e88d1fbb30cf5e908c0b4cc601628a04e90553))
- **dx:** find_symbol symbols hint back within the 20-word inline budget
  ([b8f0554](https://github.com/artk0de/TeaRAGs-MCP/commit/b8f0554094aac1d3affef2f129cbe9777b290296))
- **dx:** fit Codex SessionStart context under the hook-output cap
  ([0c9b8b8](https://github.com/artk0de/TeaRAGs-MCP/commit/0c9b8b8c59c908b60ea342c4d92e6bb5a33e4b8a))
- **dx:** identifier lookups never wait on an embedding outage; literal
  drift-consent line
  ([cf074d8](https://github.com/artk0de/TeaRAGs-MCP/commit/cf074d81442a4211e348778eb5a197340358675c))
- **dx:** literal error phrase → code search then find_symbol; demanded search
  on an error → bug-hunt
  ([9a9cab1](https://github.com/artk0de/TeaRAGs-MCP/commit/9a9cab1958e3cddde93e2efc60d9a55bfbf09dff))
- **dx:** name the installed SKILL.md of every routed skill in Codex routing
  hooks
  ([96cd57d](https://github.com/artk0de/TeaRAGs-MCP/commit/96cd57db519be8c9bd61875068e2e4eca2a1bd2c))
- **dx:** pending re-call keyed on the pendingFiles count; incremental reindex
  rides beside the --force ask
  ([ac065fb](https://github.com/artk0de/TeaRAGs-MCP/commit/ac065fb3bbe534145520a62156fcb9a8949f2bec))
- **dx:** plugin skills name the standard code search tool, never ripgrep
  ([01066c9](https://github.com/artk0de/TeaRAGs-MCP/commit/01066c90d90023ab7b0ccc53e38d349af1134b6e))
- **dx:** ship runtime-introspection to Codex — analytics-rerank links by real
  relative path
  ([3a0228e](https://github.com/artk0de/TeaRAGs-MCP/commit/3a0228efcd72ddbde528428af36c28819b70d9a5))
- **dx:** skill frontmatter parses as strict YAML; core runs anchor `next`
  (zes6j, q1g6s.2)
  ([eddb8e5](https://github.com/artk0de/TeaRAGs-MCP/commit/eddb8e50daeac09296e43e5e8f57bb561a894bfa)),
  closes [#56](https://github.com/artk0de/TeaRAGs-MCP/issues/56)
- **dx:** the --force ask and "reads continue" print as one line
  ([4e3c1f6](https://github.com/artk0de/TeaRAGs-MCP/commit/4e3c1f66d7240802264f00a70563060019f02883))
- **explore:** a find_symbol batch answers paths as outlines, refuses
  directories (yz10n)
  ([3fb12cf](https://github.com/artk0de/TeaRAGs-MCP/commit/3fb12cf14359609debab75542bf02f975c70d590))
- **explore:** a member miss lists its container's members, namesakes ranked by
  namespace (m9wrp)
  ([7d6c2bc](https://github.com/artk0de/TeaRAGs-MCP/commit/7d6c2bc8160ebb5a554c05a6c0b69efeff0ceb99))
- **explore:** batch find_symbol keeps a file-path row's outline under metaOnly
  (y3trx)
  ([bf46254](https://github.com/artk0de/TeaRAGs-MCP/commit/bf46254ba6f29d84b35ba890e33a0dc0937760c5))
- **explore:** core keeps the own-checkout reindex, collection and manual-read
  rules; pagination becomes a guide
  ([81a4981](https://github.com/artk0de/TeaRAGs-MCP/commit/81a49819e6fb9da24a9e7c78bcffe2635ee6c4ba))
- **explore:** directory outline rows keep their symbols through the default
  projection
  ([4897beb](https://github.com/artk0de/TeaRAGs-MCP/commit/4897beb0e52ab83849a07a4b28e37cfcd31b0662))
- **explore:** file outline lists header-block members (1x85g)
  ([bbc348a](https://github.com/artk0de/TeaRAGs-MCP/commit/bbc348ab50eb602a35f7389239d827abcba06504))
- **explore:** find_symbol answers whole classes, partial paths, metaOnly
  outlines (hditp)
  ([7608010](https://github.com/artk0de/TeaRAGs-MCP/commit/76080103e5744349792364d640dc5a2a6aaa357d)),
  closes
  [FileOutlineStrategy#postProcess](https://github.com/artk0de/FileOutlineStrategy/issues/postProcess)
  [SymbolSearchStrategy#emptyAnswer](https://github.com/artk0de/SymbolSearchStrategy/issues/emptyAnswer)
  [ExploreOps#findSymbol](https://github.com/artk0de/ExploreOps/issues/findSymbol)
- **explore:** find_symbol single-symbol miss answers empty.unknownSymbol with
  suggestions
  ([5d30cb2](https://github.com/artk0de/TeaRAGs-MCP/commit/5d30cb272b942b92359c2f1b47b98d5f6450d250)),
  closes [#partN](https://github.com/artk0de/TeaRAGs-MCP/issues/partN)
- **explore:** hide legacy migration points for vx81b
  ([43feb3f](https://github.com/artk0de/TeaRAGs-MCP/commit/43feb3fa152ce4aa195688b679b6dbd84cde552c))
- **explore:** migration drill matches relativePath through the text-indexed
  helper
  ([5db093e](https://github.com/artk0de/TeaRAGs-MCP/commit/5db093e7af9a88bb8467c817b5cc2c9f597b5491)),
  closes
  [MigrationCorpusQuery#operation](https://github.com/artk0de/MigrationCorpusQuery/issues/operation)
- **explore:** next hints address call edges, qualified ids keep their owner
  (q1g6s.15)
  ([e502674](https://github.com/artk0de/TeaRAGs-MCP/commit/e50267419e21204f7259b31897ba56e02ce63b1c)),
  closes [#partN](https://github.com/artk0de/TeaRAGs-MCP/issues/partN)
  [DuckDbSymbolStore#findSymbolChunk](https://github.com/artk0de/DuckDbSymbolStore/issues/findSymbolChunk)
- **explore:** outline drops unnamed block lines and folds
  [#part](https://github.com/artk0de/TeaRAGs-MCP/issues/part)N windows
  ([c131991](https://github.com/artk0de/TeaRAGs-MCP/commit/c1319915c67833c88ef56e83a4d3bac0f06e7f2e)),
  closes [#partN](https://github.com/artk0de/TeaRAGs-MCP/issues/partN)
  [#partN](https://github.com/artk0de/TeaRAGs-MCP/issues/partN)
- **explore:** prefer task-relevant members in budget recovery
  ([fe01183](https://github.com/artk0de/TeaRAGs-MCP/commit/fe01183afcd8c259ddf27bbae22fa86183de6bc7))
- **explore:** preserve requested files before container headers
  ([daf6eae](https://github.com/artk0de/TeaRAGs-MCP/commit/daf6eae032e2767a5a2e5c18fbf7864ad3ebfefa))
- **explore:** risk-assessment enrich.md — repair link one level deeper from
  references/
  ([72b85ee](https://github.com/artk0de/TeaRAGs-MCP/commit/72b85ee5fdedfae95a1f2859901ced3534dfb061))
- **explore:** Ruby class outline spans its first to last window (q1g6s.12)
  ([8f3c594](https://github.com/artk0de/TeaRAGs-MCP/commit/8f3c594417585a5ff080e4c3e2320b0d37296318))
- **explore:** table fold keeps partial-index where and FK on_delete/on_update
  (7dcty.3)
  ([99674c5](https://github.com/artk0de/TeaRAGs-MCP/commit/99674c5735f4ee932913a3d9a8328497a1d0c688))
- **explore:** tests-as-context keeps a one-call probe when the metrics resource
  is unreadable
  ([5353a95](https://github.com/artk0de/TeaRAGs-MCP/commit/5353a955e5aa1689cbb20ba021571a1877ae630e))
- **explore:** variant-cap hint names the cap; lower-bound note drops 'never
  report' (2vuz, nknkg.1)
  ([81cc07c](https://github.com/artk0de/TeaRAGs-MCP/commit/81cc07c82351a24a94732b98641cba387c694aa5))
- **graph:** unresolved callees leave rows, trace_path explains empty, stable
  columns (q1g6s.11)
  ([2ca4180](https://github.com/artk0de/TeaRAGs-MCP/commit/2ca4180f8c91b2248d319ce81cad678b6d670402))
- **harness-codex:** the one-file-per-command rule names no tool
  ([524e849](https://github.com/artk0de/TeaRAGs-MCP/commit/524e84974073ad970038cd18f6381fbace4b9039))
- **harness:** run Cursor sessionStart hooks against the workspace, not the
  plugin dir
  ([b8b20cf](https://github.com/artk0de/TeaRAGs-MCP/commit/b8b20cff5e0f8b6281bbbf4b4ea02e60faa64885))
- **harness:** share nonblocking reread steering across hosts
  ([2762a14](https://github.com/artk0de/TeaRAGs-MCP/commit/2762a149126f5f586256efc679451e653c161b40))
- **hooks:** record only code actually delivered to the agent
  ([65c40bd](https://github.com/artk0de/TeaRAGs-MCP/commit/65c40bd4c59ae2bc81be163bfe3bf894957d5519))
- **ingest:** a runtime-skipped file never enters the snapshot as indexed;
  report index holes (muj77)
  ([17831f5](https://github.com/artk0de/TeaRAGs-MCP/commit/17831f54ef7f4d1b074b2cb1739732cd562e5b53)),
  closes
  [SourceFileIngestor#recordFailure](https://github.com/artk0de/SourceFileIngestor/issues/recordFailure)
  [SkippedFileStore#paths](https://github.com/artk0de/SkippedFileStore/issues/paths)
  [#retryablePaths](https://github.com/artk0de/TeaRAGs-MCP/issues/retryablePaths)
  [IndexPipeline#saveSnapshot](https://github.com/artk0de/IndexPipeline/issues/saveSnapshot)
  [ReindexPipeline#executeChangesLeg](https://github.com/artk0de/ReindexPipeline/issues/executeChangesLeg)
- **ingest:** guard incomplete migration updates for vx81b
  ([6d7503f](https://github.com/artk0de/TeaRAGs-MCP/commit/6d7503f603a950d877957df3ecbd69223e3f5458))
- **ingest:** migration corpus honours project ignore patterns (vx81b)
  ([0b4b7b2](https://github.com/artk0de/TeaRAGs-MCP/commit/0b4b7b2354a8730c9b621ac8b34f28f468ef44b1))
- **ingest:** same-process lock handover no longer reported as dead-writer
  takeover (gciir)
  ([2320bff](https://github.com/artk0de/TeaRAGs-MCP/commit/2320bff4afc21601c71bc01cd6549259f9c48bec))
- **ingest:** update migration corpus incrementally for vx81b
  ([5a8aa7d](https://github.com/artk0de/TeaRAGs-MCP/commit/5a8aa7d640557b99ba3edf9c21b9ac15c5c721c3))
- **maintenance:** purge a stale generation by physical name, never through its
  live alias (expwb)
  ([4e20876](https://github.com/artk0de/TeaRAGs-MCP/commit/4e2087684f0488c90f0190f4d9d129bb2850623f)),
  closes
  [QdrantArtifact#remove](https://github.com/artk0de/QdrantArtifact/issues/remove)
- **maintenance:** purge clears interrupted-write temp entries; doctor reports
  what a purge left (expwb)
  ([75f5408](https://github.com/artk0de/TeaRAGs-MCP/commit/75f540879e8053abfb276cea3992a5279ec6a6e3)),
  closes
  [SnapshotArtifact#remove](https://github.com/artk0de/SnapshotArtifact/issues/remove)
- **mcp:** a diff's names come from review_changes naming, never hand-listed
  ([40f9882](https://github.com/artk0de/TeaRAGs-MCP/commit/40f98820ea89f57bf62cd30510c6113e2945ac8a))
- **mcp:** get_naming_lexicon description budget 300 → 400 chars
  ([8d8b844](https://github.com/artk0de/TeaRAGs-MCP/commit/8d8b844ac45a3ffafe9c8b372fc5cda4340eba83))
- **mcp:** guide text points label lookups at the project metrics resource
  ([734f901](https://github.com/artk0de/TeaRAGs-MCP/commit/734f901b42c36d5afc0014c87c9a80941f843764))
- **mcp:** one metrics template reads every query-param combination
  ([dc68c2f](https://github.com/artk0de/TeaRAGs-MCP/commit/dc68c2f236e83b1495629069d62e22fe14b9634e))
- **mcp:** search results tabulate from two rows on (zn0fg)
  ([3eff6ac](https://github.com/artk0de/TeaRAGs-MCP/commit/3eff6ac85e058addcf0561a85168330584b0c9eb))
- **plugins:** explore discovery-first for "how does X work", doc-claim
  verification calls (paae3)
  ([143892d](https://github.com/artk0de/TeaRAGs-MCP/commit/143892d64d821ef883c61cc2c12259cb1f57e4eb))
- **qdrant:** a sandboxed client attaches to the machine daemon, never wipes or
  twins it (hdl65)
  ([b0897cf](https://github.com/artk0de/TeaRAGs-MCP/commit/b0897cfe91c27aadd26cb043a988f1eb38214539))
- **qdrant:** daemon.refs tracks live holder PIDs, released on exit
  (tea-rags-mcp-8cgsw)
  ([91de628](https://github.com/artk0de/TeaRAGs-MCP/commit/91de6283ca8f8493cb7ab829534b2516841f6e70))
- **registry:** a failing registry dir watch degrades to polling instead of
  crashing (mqxfd)
  ([5a220c6](https://github.com/artk0de/TeaRAGs-MCP/commit/5a220c6361adf10b5d1d455b1da247f2dee8cf30)),
  closes
  [CollectionRegistry#startWatching](https://github.com/artk0de/CollectionRegistry/issues/startWatching)
- **review:** admit untracked paths by the ingest rule and budget the answer
  ([38ab020](https://github.com/artk0de/TeaRAGs-MCP/commit/38ab02089afb0a7bba8ec2696e0d936500ec3657)),
  closes
  [FileScanner#accepts](https://github.com/artk0de/FileScanner/issues/accepts)
- **risk-assessment:** a named module scopes to its stem directory
  ([0d0d3d2](https://github.com/artk0de/TeaRAGs-MCP/commit/0d0d3d2836b4c0cc4bbf931580369350d5c460b5))
- **scripts:** build-freshness hook finds the package root through a bin linked
  into build/cli
  ([bf8bed0](https://github.com/artk0de/TeaRAGs-MCP/commit/bf8bed0d2c65675d77a1a4c632d7a37eede8528c))
- **scripts:** Codex core tells the model to open a skill before planning
  ([2b0f29f](https://github.com/artk0de/TeaRAGs-MCP/commit/2b0f29f9189ec3ed20e983eac3de0068ab35b575))
- **scripts:** Codex literal search includes dot-dirs, skips .git (onli7)
  ([4348e3c](https://github.com/artk0de/TeaRAGs-MCP/commit/4348e3cc9f2a8926dc83f489808aaa8492999852))
- **scripts:** Codex package says how to call tea-rags tools under code mode
  ([76bc22a](https://github.com/artk0de/TeaRAGs-MCP/commit/76bc22aa6ff6ce216cb693ae193ada170ac8d61b))
- **scripts:** drop the PreCompact rule injection; warn on a stale dev build
  ([b44ef95](https://github.com/artk0de/TeaRAGs-MCP/commit/b44ef95222965f77d2e6bafe18f03a91ddb6fc98))
- **scripts:** each harness names one concrete code search / read tool, Claude
  too (onli7)
  ([87b2062](https://github.com/artk0de/TeaRAGs-MCP/commit/87b206274a9ad60b0f18f39c9971f39058e56bd0)),
  closes [#67](https://github.com/artk0de/TeaRAGs-MCP/issues/67)
- **scripts:** give Codex hooks room for a cold tea-rags prime
  ([3e01a03](https://github.com/artk0de/TeaRAGs-MCP/commit/3e01a035c2c47342b04d76f11f5249fbfb0a1cfe))
- **scripts:** give the Cursor sessionStart hook room for a cold tea-rags prime
  ([675e72a](https://github.com/artk0de/TeaRAGs-MCP/commit/675e72ae91d1d8d069f22606da222247a62b3693))
- **scripts:** Rust residual taxonomy reads match-arm patterns only (s3i8m.1)
  ([99bfcfe](https://github.com/artk0de/TeaRAGs-MCP/commit/99bfcfed3ea61410c5cc0e63338cb2220f863917))
- **scripts:** working-tree spikes import from src, not build
  ([ced48f3](https://github.com/artk0de/TeaRAGs-MCP/commit/ced48f3b4ddddf9cf3d93e08675337278cb2825c))
- **test:** AppConfig fixture carries experimentalLocateEnable (type-check:tests
  red after fab2a404a)
  ([b93931d](https://github.com/artk0de/TeaRAGs-MCP/commit/b93931d71b12e4b722ec71a4e7ae1ee6016de87d))
- **trajectory:** keep Rust impl-block, alias-impl and deref-field reads the
  import read displaced
  ([27a3035](https://github.com/artk0de/TeaRAGs-MCP/commit/27a303554dd15e5feab49389f334a7389d67b1ff)),
  closes [Res#map](https://github.com/artk0de/Res/issues/map)
  [Res#unwrap](https://github.com/artk0de/Res/issues/unwrap)
- **trajectory:** keep the Rust walker's inferred local shapes additive
  ([59d7809](https://github.com/artk0de/TeaRAGs-MCP/commit/59d7809ee51965b7df86c13350dc712eb2cf0fcd))
- **trajectory:** key Rust resolver memos by run scope
  ([a34c3e7](https://github.com/artk0de/TeaRAGs-MCP/commit/a34c3e733c7c18579b3c8d08a5083423dd375e15))
- **trajectory:** make Rust item-path placement additive to the pre-placement
  read
  ([eeb97b6](https://github.com/artk0de/TeaRAGs-MCP/commit/eeb97b68d52f32e0a5d73ae62ed1980f224fd048))
- **trajectory:** map a rustc driver def outside the kept same-id window to its
  owner's symbol
  ([7322f01](https://github.com/artk0de/TeaRAGs-MCP/commit/7322f0197002cbfd2419eb5634c0000774111424))
- **trajectory:** map rustc same-id windows on foreign, aliased and module
  owners
  ([e38d7ae](https://github.com/artk0de/TeaRAGs-MCP/commit/e38d7aee6e75ef210d6cf935acfdecbc0314af1e))
- **trajectory:** recover Rust re-rooted Trusted and ?-unwrapped Result
  receivers (s3i8m)
  ([3506311](https://github.com/artk0de/TeaRAGs-MCP/commit/35063116cec88c11c88b37f34e59ecebc589b3a1))
- **trajectory:** Rust agreeing twin returns and concrete Self::Target type
  (s3i8m)
  ([1dd19ce](https://github.com/artk0de/TeaRAGs-MCP/commit/1dd19ce163f57066180db39fe91b592fe506442f))
- **trajectory:** Rust bare macros resolve through #[macro_use] extern crate
  (s3i8m.4 B2)
  ([3c0688e](https://github.com/artk0de/TeaRAGs-MCP/commit/3c0688e46ada8cce447bc28d007d0620fd8d681e))
- **trajectory:** Rust chain typing defers to the prior read on an unplaceable
  typed hop (s3i8m.5)
  ([fbe479b](https://github.com/artk0de/TeaRAGs-MCP/commit/fbe479b13b837d419a7e3246c099f89f7b8431b7))
- **trajectory:** Rust exported macros resolve across crates via use and path
  (s3i8m.4 B1)
  ([dc12a91](https://github.com/artk0de/TeaRAGs-MCP/commit/dc12a915333f9f50eff7983c2f14266358491ff9))
- **trajectory:** Rust importMatch follows pub use re-exports instead of
  dropping (s3i8m.8)
  ([edbdf9b](https://github.com/artk0de/TeaRAGs-MCP/commit/edbdf9b188aafc41bb3439444371c687b70143f8))
- **trajectory:** Rust macro invocations resolve in the macro namespace
  (s3i8m.2)
  ([7f0a9a2](https://github.com/artk0de/TeaRAGs-MCP/commit/7f0a9a27b209d753b91b1db75afd1def982fc59f))
- **trajectory:** SCIP trait declarations prove external only without a project
  impl (s3i8m.6 R3c)
  ([e5b9213](https://github.com/artk0de/TeaRAGs-MCP/commit/e5b92139038eee24ea9a405c640d830e3559d3a1))
- **trajectory:** SCIP trait refs on proven std receivers stay external (s3i8m.6
  R3d)
  ([fe6c657](https://github.com/artk0de/TeaRAGs-MCP/commit/fe6c657eb386966448e022510fa9f1a4bf208811))
- **trajectory:** typed Rust pattern receivers deref and fall through on
  unproven misses (s3i8m 1d)
  ([d47cc20](https://github.com/artk0de/TeaRAGs-MCP/commit/d47cc203711f89efc78cb51edc6013a962171544)),
  closes [Error#clone](https://github.com/artk0de/Error/issues/clone)
  [FormControl#to_element](https://github.com/artk0de/FormControl/issues/to_element)
- **trajectory:** untyped Rust pattern bindings fall through instead of dropping
  (s3i8m 1c)
  ([274c7a0](https://github.com/artk0de/TeaRAGs-MCP/commit/274c7a06c9c01804b0a6bebcfdf9393e50670067))

### Performance Improvements

- **api:** cut SessionStart prime and MCP boot waits (o4p5l)
  ([77c5758](https://github.com/artk0de/TeaRAGs-MCP/commit/77c5758c96b17ae780fe0dab1e72b1ca6ca08976)),
  closes
  [IndexingOps#getStatus](https://github.com/artk0de/IndexingOps/issues/getStatus)
  [App#getIndexMetrics](https://github.com/artk0de/App/issues/getIndexMetrics)
- **embedding:** status probe reads live down verdict instead of re-probing
  (sm1ow)
  ([eb0e8b6](https://github.com/artk0de/TeaRAGs-MCP/commit/eb0e8b6c013adbc2829be1b76e74a90a512cc001)),
  closes
  [LlamaServerEmbeddings#checkHealth](https://github.com/artk0de/LlamaServerEmbeddings/issues/checkHealth)
- **explore:** hot-cache an unchanged working tree behind an fs-watch change
  clock (4qdj0)
  ([ccaf810](https://github.com/artk0de/TeaRAGs-MCP/commit/ccaf810bf9bd8bd9c95deb3c6b99c3a179d2a64a))
- **qdrant:** create collections with one segment (zd63a)
  ([ef46d7b](https://github.com/artk0de/TeaRAGs-MCP/commit/ef46d7b238895a9d2b7be67eac8e5886fc34ec53))

### Documentation

- **adapters:** align rustc-driver SPEC §6 with reuse-only admission
  ([465ed41](https://github.com/artk0de/TeaRAGs-MCP/commit/465ed4193fb65b921d4577933b2161f871af598c))
- **beads:** carry Task 13 follow-ups into Tasks 9, 14 and 16
  ([c531dac](https://github.com/artk0de/TeaRAGs-MCP/commit/c531dac6e2659fe617a5ed305fef192e68990fa7))
- **beads:** CI regenerates and commits the harness packages (Task 18)
  ([3d74600](https://github.com/artk0de/TeaRAGs-MCP/commit/3d74600083ec84b661752b6da4ccc154440d39ec))
- **beads:** dinopowers ships as its own Codex / Cursor plugin (Task 19)
  ([5de8ff7](https://github.com/artk0de/TeaRAGs-MCP/commit/5de8ff712370dd110d587b122b36b671210ef7a4))
- **beads:** harness context economy — design and implementation plan
  (tea-rags-mcp-9lynw)
  ([e61a858](https://github.com/artk0de/TeaRAGs-MCP/commit/e61a8581ada157ca6a95b16e2eb27fa760642954))
- **beads:** one plugin source under plugins/, every harness package generated
  (Tasks 17-18)
  ([51ca08a](https://github.com/artk0de/TeaRAGs-MCP/commit/51ca08a8fe8d402a13373e3cd958e80f00de8d45))
- **beads:** plan follows delivered Task 1-3 and verified Codex/Cursor facts
  (tea-rags-mcp-9lynw)
  ([ee5d071](https://github.com/artk0de/TeaRAGs-MCP/commit/ee5d071eb8c266b1f5457001b907b27f2e136215))
- **beads:** release regenerates the harness packages via gen:plugins (Task 18)
  ([73b65a3](https://github.com/artk0de/TeaRAGs-MCP/commit/73b65a31fd1ed4fa557383e0882d48d6b81bd673))
- **beads:** Task 14 adds the full eval run on Codex
  ([d5795fb](https://github.com/artk0de/TeaRAGs-MCP/commit/d5795fbe72581d877d2166c8c1dae593313c638d))
- **beads:** Task 18 — drift tests become render tests, prebuild regenerates the
  agent context
  ([c1ad8d0](https://github.com/artk0de/TeaRAGs-MCP/commit/c1ad8d0b0be96293d1995e107c7553cc62d95fce))
- **beads:** Task 20 — guide prose moves to plugin markdown with data
  placeholders
  ([054d0f0](https://github.com/artk0de/TeaRAGs-MCP/commit/054d0f0d06c0c262a1019af24778039c6588da41))
- column-table reading in skills, response-shape invariant (zn0fg)
  ([d3f494d](https://github.com/artk0de/TeaRAGs-MCP/commit/d3f494d6564cd2e5ee6dc8069a4560de104d6f19))
- **docs:** plan Task 10 — record skill split and test-file deviations
  ([8b6ae42](https://github.com/artk0de/TeaRAGs-MCP/commit/8b6ae427a7f330a11457335f6998e49292d8b34e))
- **dx:** agent guidance for batch find_symbol, dir listing, empty reasons, lean
  metaOnly
  ([a37f2b2](https://github.com/artk0de/TeaRAGs-MCP/commit/a37f2b218433eb95bc764872a9b90a4b5da700b1)),
  closes [#partN](https://github.com/artk0de/TeaRAGs-MCP/issues/partN)
- **dx:** best practice 69 — plan literals live in core, triggers keyed on
  reported values
  ([2963468](https://github.com/artk0de/TeaRAGs-MCP/commit/296346809582660cf4aa0d505801a536e84854d1))
- **dx:** best practice 70 — measure fixes in the smallest run unit
  ([25787c2](https://github.com/artk0de/TeaRAGs-MCP/commit/25787c2d3bfc4033092b9acd5da5f004d3a0b9eb))
- **dx:** close eval r2-r8 routing gaps in core, guides, wrappers; Codex hook
  budget 8700
  ([24c22be](https://github.com/artk0de/TeaRAGs-MCP/commit/24c22be0ac1ccbceee041733aecc0ba83368d835))
- **dx:** core anchor = row naming the task's behaviour, ordered drill then
  graph calls, coverage before answering (q1g6s.2)
  ([b729439](https://github.com/artk0de/TeaRAGs-MCP/commit/b7294398e3959dbb278fa276b3118659674ef75f))
- **dx:** core unknownPath retry + review_changes {} vs {base}; Codex hook
  budget 9100 (q1g6s.2)
  ([4fe47c8](https://github.com/artk0de/TeaRAGs-MCP/commit/4fe47c81de9344da3055ca8671ea9546b69c846f))
- **dx:** embed report trimming, budget guard and empty reasons in plugin
  guidance
  ([993f3a4](https://github.com/artk0de/TeaRAGs-MCP/commit/993f3a4454e8b6335282a3c5cf73c1bc4d4d4502))
- **dx:** explore regression check after the yz10n path-batch rule (yz10n)
  ([cc80e66](https://github.com/artk0de/TeaRAGs-MCP/commit/cc80e66aa8231539fe40157772b9cb987c9df22e))
- **dx:** fix confirmed q1g6s eval forks in core, explore, DDG and wrappers
  ([bdfc2c8](https://github.com/artk0de/TeaRAGs-MCP/commit/bdfc2c8c591ffe82d32a1fa4e07d5736b6523ef8)),
  closes [Class#method](https://github.com/artk0de/Class/issues/method)
  [#51](https://github.com/artk0de/TeaRAGs-MCP/issues/51)
- **dx:** navigation guide — run anchor next calls in order before a new search
  (q1g6s.2)
  ([23303dc](https://github.com/artk0de/TeaRAGs-MCP/commit/23303dc688d091837eefbb521315adbd22530132))
- **dx:** navigator practices 33-35 from T22 r28-r31
  ([7ca0d55](https://github.com/artk0de/TeaRAGs-MCP/commit/7ca0d557aef5927f3b064f7d80864a45f334ce78))
- **dx:** plugin text drops rg/ripgrep for default code search/read tool roles
  (32pzr)
  ([e0614d6](https://github.com/artk0de/TeaRAGs-MCP/commit/e0614d65b554fb22f5eb16d8d91a5699ebe1474c))
- **dx:** route truncated answers in core, raise core cap to 6600
  ([7fca3ac](https://github.com/artk0de/TeaRAGs-MCP/commit/7fca3acf9653332a3a14e832a823f0da2d12acc6)),
  closes [#69](https://github.com/artk0de/TeaRAGs-MCP/issues/69)
  [7/#50](https://github.com/7/TeaRAGs-MCP/issues/50)
- **dx:** the 3/3 eval gate is Codex-only; Claude runs once per suite
  ([887e119](https://github.com/artk0de/TeaRAGs-MCP/commit/887e119a7faaebf5e2d0993a685e74e37571684f)),
  closes [#37](https://github.com/artk0de/TeaRAGs-MCP/issues/37)
  [#70](https://github.com/artk0de/TeaRAGs-MCP/issues/70)
- **dx:** thresholds live in the metrics resource, not prime
  ([c34df5a](https://github.com/artk0de/TeaRAGs-MCP/commit/c34df5ab611496a82f7c0c91b9306c432c5874e5))
- **explore:** agent turn economy phase-1 implementation plan (q1g6s)
  ([3ccd348](https://github.com/artk0de/TeaRAGs-MCP/commit/3ccd34876f33a0b9291d828321bc04f1f0f80ff2))
- **explore:** design agent turn economy tools (batch drill, dir outline, lean
  payload, hints)
  ([174c36c](https://github.com/artk0de/TeaRAGs-MCP/commit/174c36c7d18a4b07c2c3a973a975907f11192ac5))
- **harness:** record the Cursor live test in harness/cursor/LIVE-TEST.md
  ([1a81f22](https://github.com/artk0de/TeaRAGs-MCP/commit/1a81f226004f5957bcec53d83833b12d4d3000f8))
- **ingest:** design isolated Rails migration indexing (vx81b)
  ([25b43c7](https://github.com/artk0de/TeaRAGs-MCP/commit/25b43c725a8d777d6c7ce90b601778c85a7672a4))
- mcprush badges in README; hook evals D1 Q18 on indexed code, D2 Q5 accepts
  known-name search
  ([2b9b3a8](https://github.com/artk0de/TeaRAGs-MCP/commit/2b9b3a80c3c0eecb5070d70a781e5acb019d9bc3))
- **mcp:** tool-choice guide names the code-identifier tool spelling
  ([532c417](https://github.com/artk0de/TeaRAGs-MCP/commit/532c417e03e159adc3fa77f69dbe19c5817bc0dc))
- **plan:** record the live Cursor eval in Task 15
  ([dc6cf19](https://github.com/artk0de/TeaRAGs-MCP/commit/dc6cf1947a40b959bd7bf7ae6dd84e8b9a413352))
- **plan:** Task 17 as delivered — root manifests, gen:lang-compat out, install
  check
  ([ee6fd24](https://github.com/artk0de/TeaRAGs-MCP/commit/ee6fd2498fcab2ec2670dd4c7149edb0f3de305e))
- **plan:** Task 19 delivered — dino- names, missing-superpowers line, list
  totals
  ([a8c8c7b](https://github.com/artk0de/TeaRAGs-MCP/commit/a8c8c7b2e69141ad5bbda2818c9846e225af884b))
- **plan:** Task 20 — record landed placeholder keys and the Prettier exclusion
  ([e326291](https://github.com/artk0de/TeaRAGs-MCP/commit/e326291695866f653df3e2b4b759b68364e4238b))
- **plan:** Task 21 — release bumps plugin versions, plugin scopes release
  ([3a1cddd](https://github.com/artk0de/TeaRAGs-MCP/commit/3a1cddd9b28e716caf3deb35fbcd79a8d9f28891))
- **plan:** Task 22 — evals to 100% on Claude and Codex
  ([3d71731](https://github.com/artk0de/TeaRAGs-MCP/commit/3d7173102cc1ff6d4b7d45711c462cbc13dac647))
- **plugins:** Codex round-5 fixes — mandatory reference opens, literal output
  lines
  ([e5ed73b](https://github.com/artk0de/TeaRAGs-MCP/commit/e5ed73b54e9be0264f35078c2b969ca98cab5872))
- **plugins:** Codex round-9 self-diagnosis — resolve rule conflicts it named
  ([2ffedb7](https://github.com/artk0de/TeaRAGs-MCP/commit/2ffedb72ae60ea33f2379e6af1f0563d9a96ff59))
- **plugins:** Codex self-diagnosed fixes — answer shape at the decision point,
  precedence next to the rule
  ([13e4a02](https://github.com/artk0de/TeaRAGs-MCP/commit/13e4a02e4a1a3d3211637ddf529d132cd7d687e4))
- **plugins:** literal output lines beside the step that writes them (Codex
  round 15)
  ([5ee57ff](https://github.com/artk0de/TeaRAGs-MCP/commit/5ee57ff8974c7d83f45a2854877932ed94152ca6))
- **plugins:** naming check spells its input; repair paths resolve from the
  plugin root
  ([93a1c3b](https://github.com/artk0de/TeaRAGs-MCP/commit/93a1c3b78ae8198efe8db3ff77d551b06ce90574))
- **plugins:** one canonical phase skeleton; literal forks for lean and facade
  (Codex round 17)
  ([a478d17](https://github.com/artk0de/TeaRAGs-MCP/commit/a478d171a710990109374383edcaa6efde69017a))
- **plugins:** output contracts apply in plan-only answers (Codex root cause)
  ([91d3d39](https://github.com/artk0de/TeaRAGs-MCP/commit/91d3d39048d7ca300b4244b9528a96c8bd9d03fb))
- **plugins:** print report skeletons in plan-only answers (Codex round 11)
  ([283a807](https://github.com/artk0de/TeaRAGs-MCP/commit/283a807ef1585e2e6495b443862a486db849f867))
- **plugins:** remove the forks behind Codex regression round 23
  ([55aeace](https://github.com/artk0de/TeaRAGs-MCP/commit/55aeace877932473beb64210a0a24dbfad484a3d))
- **plugins:** resolve conflicts between global rules and skill contracts
  ([81e6295](https://github.com/artk0de/TeaRAGs-MCP/commit/81e62959da2855b9b1775ff5efa2cc3347b84fc7))
- **plugins:** restore content trimmed for the size cap; literal judgment and
  triage lines (Codex round 20)
  ([b26d3d9](https://github.com/artk0de/TeaRAGs-MCP/commit/b26d3d986df64b6e1254d3fbd6bf95c726f4ec65))
- **plugins:** round-6 eval fixes — resolve ids before graph calls, Codex reads
  one file first
  ([4e220f3](https://github.com/artk0de/TeaRAGs-MCP/commit/4e220f33724b42a01c25c1ee27d7426c39c664f2))
- **plugins:** round-7 eval fixes — chain row split, file moves stay in DDG,
  superpowers availability
  ([d9a6322](https://github.com/artk0de/TeaRAGs-MCP/commit/d9a63225ea99d272e50d481190b80e245db32062))
- **plugins:** superpowers availability is checked by reading its file, not the
  skills list
  ([00c3b97](https://github.com/artk0de/TeaRAGs-MCP/commit/00c3b97e2e3db3c31554e5dbef394492e98199bd))
- **plugins:** superpowers lookup names the marketplace level of the plugin
  cache
  ([238dcde](https://github.com/artk0de/TeaRAGs-MCP/commit/238dcde1b2c1695dd01a5b78b7e1faf26ca5bcac))
- **plugins:** verification gate prints triage and GATE lines as a copyable
  block (Codex round 21)
  ([cacf57a](https://github.com/artk0de/TeaRAGs-MCP/commit/cacf57a97942ab35f49b28923121b74bfeee6b04))
- **readme:** per-harness plugin install under spoilers
  ([c9e161d](https://github.com/artk0de/TeaRAGs-MCP/commit/c9e161d2eb98198662ffa509e941c92f2a749412))
- **risk-assessment:** named module scopes to a directory; plan steps per phase
  ([363d38d](https://github.com/artk0de/TeaRAGs-MCP/commit/363d38dd960d67d8cdbe8e80f4773e2ec2f0f785))
- **rules:** expand-coverage targets the file the caller named
  ([205a843](https://github.com/artk0de/TeaRAGs-MCP/commit/205a843f7ea0f5626a84bbd4581df953a9b45261))
- **rules:** facade-discipline example matches current code; expand-coverage
  targeted run and no semantic coverage search
  ([b3cb859](https://github.com/artk0de/TeaRAGs-MCP/commit/b3cb859e571503f44374a1531fe0f78cede041e7))
- **rules:** navigator — dependency availability by file, not by the truncated
  skills list
  ([a274370](https://github.com/artk0de/TeaRAGs-MCP/commit/a274370bfc41fbf88d39492ac69ace21aded498e))
- **rules:** skill-authoring navigator for Claude Code / Codex / Cursor
  ([66e1a08](https://github.com/artk0de/TeaRAGs-MCP/commit/66e1a08f2b1a407b409416ac15831b20b60ec245))
- **rules:** skill-authoring navigator gains Codex lessons from regression round
  23
  ([5b2b17c](https://github.com/artk0de/TeaRAGs-MCP/commit/5b2b17c7b516f459943f48a4ca5c9b16f11e856c))
- **tea-rags-setup:** install invariants stated in every install answer
  ([89db143](https://github.com/artk0de/TeaRAGs-MCP/commit/89db14302e7a43e4ce8ad85e364bbe19f7d4590c))
- **tea-rags:** Codex T22 failures — mandatory steps stated where the model
  decides
  ([c85b2cb](https://github.com/artk0de/TeaRAGs-MCP/commit/c85b2cb072fa3a6013d98228f0d749edb35caf39))
- **tea-rags:** every read call passes project + path=<working directory>
  (z2vfo)
  ([74cea93](https://github.com/artk0de/TeaRAGs-MCP/commit/74cea9318c7a3ddbaa22006ce00c3e273be17937))
- **tea-rags:** failing eval cases' rules made explicit in core and skills
  ([3bf3bc5](https://github.com/artk0de/TeaRAGs-MCP/commit/3bf3bc528deecd7b481c8464ea7eee7829fda3e5))
- **tea-rags:** index lag never licenses leaving tea-rags for shell reads
  ([fc7a57c](https://github.com/artk0de/TeaRAGs-MCP/commit/fc7a57c58f6bb83cd6828490c960a3af0c634db0))
- **tea-rags:** literal text goes to the client's own text search, not ripgrep
  MCP
  ([12266a0](https://github.com/artk0de/TeaRAGs-MCP/commit/12266a0001c0eb0383ec05ca694a928dc21f4a8f))
- **tea-rags:** read search answers as column tables (zn0fg)
  ([f91af73](https://github.com/artk0de/TeaRAGs-MCP/commit/f91af733350604ad9bcfa00f2f25b004ef4388e5))
- **tea-rags:** round-3 eval fixes — intent classification stated first, digest
  silence no longer read as codegraph off
  ([f2acccd](https://github.com/artk0de/TeaRAGs-MCP/commit/f2acccd56f1484c04fc5df4d6b052fc4fbf4fcd9))
- **tea-rags:** round-4 eval fixes — naming and behaviour routing in core,
  codegraph-off rule first in references
  ([e16047b](https://github.com/artk0de/TeaRAGs-MCP/commit/e16047bdb4355a7e4e36644ea5517249ec772527))
- **trajectory:** Rust residual after the rustc driver, precise join and static
  precision (s3i8m)
  ([0cd2320](https://github.com/artk0de/TeaRAGs-MCP/commit/0cd232087ab82c0507270fe455d70e425b5df44b)),
  closes [Res#unwrap](https://github.com/artk0de/Res/issues/unwrap)
  [Response#Ok](https://github.com/artk0de/Response/issues/Ok)
- **trajectory:** rustc call-site driver spec replaces rust-analyzer SCIP
  (s3i8m)
  ([c919a3b](https://github.com/artk0de/TeaRAGs-MCP/commit/c919a3b001ba3ca6536e48ab56063e92e39b144f))
- **trajectory:** rustc driver on by default; keep vendored crates out of the
  index (s3i8m)
  ([eacbb91](https://github.com/artk0de/TeaRAGs-MCP/commit/eacbb9181ec89ce3788f6e48c7092be5e9405837))
- **website:** ask Rust users to install the rustc driver toolchain
  ([8111fe3](https://github.com/artk0de/TeaRAGs-MCP/commit/8111fe335dc384b95c61d45e858d4575d8e90dbe))
- **website:** document the Rust compiler driver and its env vars
  ([f20f7df](https://github.com/artk0de/TeaRAGs-MCP/commit/f20f7dfb0e618e3afa81b79b798a9f8a32cb1ed7))
- **website:** point Apple Silicon llama-server setup at the install wizard
  ([95e0011](https://github.com/artk0de/TeaRAGs-MCP/commit/95e00117ef4f78a4b817f05a2ed1a9a6163fad25))

### Code Refactoring

- **adapters:** rename the rustc driver crate to tea-rags-rustc-driver
  ([8677a89](https://github.com/artk0de/TeaRAGs-MCP/commit/8677a89b5d995a21d6cc0b9c195a51e32e206917))
- **api:** rename DTO CycleMemberLocation to CycleResultMemberLocation (e1lp7)
  ([9bb551c](https://github.com/artk0de/TeaRAGs-MCP/commit/9bb551c0a63f36f3b367bddf96cde5a44f64494e))
- **codegraph:** exhaustive Python derived-binding fold, drop literal concat
  ([0b6252b](https://github.com/artk0de/TeaRAGs-MCP/commit/0b6252bffc5716370a8c843045185db4f1a0d3a6))
- **mcp:** text tools serialise through formatMcpResponse (zn0fg)
  ([2bbf2c7](https://github.com/artk0de/TeaRAGs-MCP/commit/2bbf2c7144ff4a731ab73ce59cb83b2782a2b988))
- **plugins:** plugin sources live in plugins/, Claude packages generated
  ([1123be3](https://github.com/artk0de/TeaRAGs-MCP/commit/1123be3e8aace2657c7c2eacb9a612f8c62ad734))
- **resources:** guide prose moves to plugin markdown templates with data
  placeholders
  ([de5a2fb](https://github.com/artk0de/TeaRAGs-MCP/commit/de5a2fb171e87a0501b6a90d83d7695a5b81e431))
- **trajectory:** remove the rust-analyzer SCIP engine; the rustc driver is the
  one source
  ([5cecf1c](https://github.com/artk0de/TeaRAGs-MCP/commit/5cecf1c0b3ede3037078f88cf127c47f112f891a))

## [1.49.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.48.0...v1.49.0) (2026-10-18)

### 🧠 Code intelligence

- Call sites that static analysis cannot settle can now be resolved by the Kev
  model, and the answers become model edges in the call graph. Callers,
  `trace_path`, `find_cycles` and architecture findings mark model-derived hops
  and a path's weakest verdict, and model edges count in the resolve success
  rate
- Residual resolution accuracy is tuned per repository: accept thresholds are
  calibrated per language from a sample of statically settled call sites, then
  applied automatically, and residual questions are grouped per receiver with
  narrower menus, receiver-name hints and confirmation re-asks
- **_Ruby_**, **_Python_** and **_Django_** call graphs resolve more calls:
  relation chains and querysets type on the model, constructors and `self.class`
  receivers resolve, attribute readers and association elements get types,
  caller parameters are typed from callers and literals, and
  **_Rails_**-generated or untyped-receiver noise no longer counts as unresolved

### ⚡ Indexing & performance

- Indexing with llama-server embeddings no longer falls into timeout retry
  storms on a slow GPU: requests are capped per server slot, the adaptive tuner
  returns to its best point after a slow spell, and embedding failures are
  logged with their cause
- **_Rust_** source chunking is hardened, with better dispatch, test chunking,
  alias handling and comment capture

### 🗣 Language support

- **_Rust_** **call-graph** navigation resolves far more calls: external crates,
  workspace crates, import-bound calls, auto-deref and smart pointers, declared
  struct fields and return chains, and cross-file function call results

### 🛠 CLI & workflow

- **Breaking:** the call graph is now on by default (`CODEGRAPH_ENABLED`
  defaults to true). Registered projects keep the state they were indexed with;
  to index a new project without it set `CODEGRAPH_ENABLED=false` or run
  `tea-rags projects set-env --name <alias> CODEGRAPH_ENABLED=false`, and to
  enable it for an existing project run
  `tea-rags projects set-env --name <alias> CODEGRAPH_ENABLED=true` and reindex
- New `resolve-codegraph-residual` command and
  `index-codebase --resolve-residual` flag run residual resolution, with its own
  progress bar and reports that print the accept thresholds and their source

### 🧩 Agent plugin

- Skills run the pre-write architecture simulation only before a file move,
  merge or split, and read model hops and minimum-probability markers in graph
  answers

### 📚 Documentation

- **Docusaurus:** Kev setup page, residual-resolution spec and measured
  accuracy, plus adaptive embedding and llama-server slot notes
- **README:** removed the Kev residual resolution section

### 🩹 Fixes

- **_Rust_** imports resolve correctly for self/super paths, group import
  aliases and caller-crate module scopes
- Residual resolution is more reliable: thresholds are applied per language,
  timed-out requests are requeued, in-flight asks cancel cleanly, default
  concurrency is lower so a stalled model no longer queues requests, and edges
  survive incremental tree rebuilds
- **_Ruby_** **call-graph** fixes: dots inside call arguments are no longer
  treated as chain hops, `x.class` is treated as a class object, and every
  readable mixin is recorded
- Hub evidence lists show only the neighbours the verdict counts

### 🔧 Environment Variables

- `CODEGRAPH_ENABLED` · Index the code call graph; now on by default · default:
  `true` (changed)
- `CODEGRAPH_RESIDUAL_REQUEST_TIMEOUT_SEC` · Timeout for a residual-resolution
  request to Kev · default: `300` (new)
- `CODEGRAPH_RESIDUAL_MAX_QUESTIONS_PER_REQUEST` · Cap on questions per residual
  request · default: `unset` (new)
- `CODEGRAPH_RESIDUAL_MAX_CRITERIA_PER_REQUEST` · Cap on criteria per residual
  request · default: `unset` (new)
- `CODEGRAPH_RESIDUAL_NAME_PRIOR_ACCEPT_THRESHOLD` · Separate accept threshold
  for name-prior residual picks · default: `unset (uses the provider threshold)`
  (new)
- `CODEGRAPH_RESIDUAL_KEV_SESSION_URL` · GPU broker session URL used to lease
  Kev for the residual pass · default: `unset` (new)
- `CODEGRAPH_RESIDUAL_CONCURRENCY` · Concurrent residual requests · default:
  `16` (changed)

## [1.48.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.47.0...v1.48.0) (2026-10-14)

### 🧠 Code intelligence

- **Breaking:** `get_architecture_report` no longer returns
  `summary.layering.facadePartition`; every component detector now judges on one
  domain partition, so SDP, main-sequence, hub-like and shotgun findings change
  component names and counts
- `review_changes` judges the whole diff (no 200-file cap) and splits
  architecture findings into introduced, resolved and persisting, each with
  verified remedies such as import retargets
- `review_changes` reports dependency-norm verdicts for added edges and carries
  violation impact tiers, and resolves working-tree edges for every
  **codegraph** language
- `get_architecture_report` gains a what-if `restructure` mode and a greedy
  `restructurePlan`, with edge ops that compose in order, so you can plan a
  refactoring before touching code
- `get_architecture_report` verdicts for planned edges at write time, hub-like
  dependency detection, shotgun-surgery detection from co-change history,
  propagation-cost and core-periphery shape, and violations ranked by
  maintenance cost
- Dependency norms are judged against an independence null and as direction
  inversions, and **_Ruby_** components are partitioned by constant namespace
- Field-access relationships between methods are now tracked for
  **_TypeScript_**, **_JavaScript_** and **_Ruby_**, feeding architecture
  analysis
- Architecture findings carry stable identity keys so the same finding can be
  tracked across runs
- Change-reason extraction groups ticket domains per component, and task ids
  with hash suffixes are recognised from commit history
- Directory-role analysis counts async instance methods of a class

### ⚡ Indexing & performance

- Migrations can now run procedural steps tracked in the ledger, and legacy
  review edge tables are dropped

### 🛠 CLI & workflow

- `tea-rags:refactoring-planning` skill guides ordered, simulated refactorings

### 🧩 Agent plugin

- Co-change support counts author bursts, not sessions; architecture-diagnostics
  names the dependency-norm verdict exclusions
- `architecture-diagnostics` and `risk-assessment` read remedy, preExisting and
  per-family repair files for architecture findings
- `data-driven-generation` gains red-first triage, a Step 7 fix-at-write loop
  with merge-base evidence and session-context reuse, and `review_changes`
  triage of nonLocal and persisting findings

### 🩹 Fixes

- `review_changes` is more accurate: diff findings are judged against the
  merge-base, deleted and renamed files are handled, and false positives from
  facades, type-only imports, test partners and version manifests are gone
- Architecture report findings are more trustworthy: fewer false positives for
  islands, hubs, layering, shotgun surgery, silent coupling, test support and
  dependency norms
- Git author identities are unified by mailmap-applied email with one canonical
  display name, and ticket keys are learned per run
- Naming and directory-role analysis is steadier: stable verdicts near the
  similarity floor, correct handling of interfaces, types and head nouns
- **Call-graph** resolution is more complete across **_TypeScript_** re-exports
  and type-only imports, **_Swift_** constants and identifiers, and reopened
  **_Ruby_** classes, mixins and **_ActiveRecord_** relations
- The embedding failover no longer loops forever on a peer that reports healthy
  but fails every request, and status explains why an endpoint is unavailable
- Comma-separated `EMBEDDING_BASE_URL` and `EMBEDDING_FALLBACK_URL` are now
  rejected for ollama with a clear error
- The macOS launchd agent starts `llama-server` directly so Background Items can
  enable it at login
- A **Qdrant** daemon whose pid and port files were lost is re-adopted instead
  of a second one being spawned; waited writes that time out are no longer
  treated as success; the `relativePathExact` index heals missing points
- `index-codebase --languages` now refuses a language the index does not hold,
  and a language-scoped recompute takes uncovered paths
- **_Go_** module maps and test-dependency manifests are read from the work-tree
  listing, and git probe timeouts are retried before falling back
- Chunker worker processes inherit the parent's debug flag
- `get_naming_lexicon` rejects the removed `changes`/`files` params, and its
  schema stays within its size budget
- The blame pool default now follows the git trajectory setting

## [1.47.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.46.0...v1.47.0) (2026-10-06)

### 🔎 Search & ranking

- Searches now see your uncommitted working tree: `semantic_search`,
  `hybrid_search` and `find_symbol` answer from edited files alongside the
  index, rows from stale index data are flagged with `treeState`, and every read
  answer carries a `workingTree` marker
- Working-tree answers stay fast and fresh: edited trees are kept warm by a
  watcher and served within a wait budget, and graph tools such as callers and
  symbol lookup answer from the working tree
- Searching with an unreachable embedder fails fast and `hybrid_search` still
  answers from keyword matching
- Test search results include each example's shared setup code, hydrated on read
- Search signal ranking: `rank_chunks` now orders correctly by age, and
  parameter and return-name naming verdicts are more accurate

### 🧠 Code intelligence

- New `review_changes` tool reviews a diff for architecture problems, silent
  couplings, facade-contract changes, incomplete changes and split/merge
  candidates, flagging pre-existing issues separately
- Dependency norms and write-time verdicts judge a planned edge against the
  project's own precedents
- `get_architecture_report` infers architectural layers, shows a layer map,
  ranks layering knots with keep-cost per cut edge, and can drill into one knot
  or judge one directory as its own system
- Architecture findings are more accurate: re-export cycles, leaking
  abstractions, naming collisions, strict-JSON output and small-project guards
  are corrected
- New `find_co_changed` tool lists files that change together with a given file
- `get_naming_lexicon` judges untyped methods by the project's verb vocabulary,
  understands **_Ruby_** class state and accessor macros, sees **worktrees** and
  marks index lag; `get_ontology_report` gains a verbs section
- **Breaking:** `get_naming_lexicon` no longer accepts `changes` or `files`; use
  `review_changes` with `changes: {base}` and `sections: ["naming"]` for
  diff-scoped naming review

### ⚡ Indexing & performance

- New `llama-server` embedding provider (`EMBEDDING_PROVIDER=llama-server`)
  spreads batches across several GPUs or servers by measured throughput, fails
  over between peers and a local fallback, and drops endpoints serving the wrong
  model
- Endpoint lists accept port shorthand such as
  `EMBEDDING_BASE_URL=http://host:8081,8082`
- A missing **Ollama** model is pulled automatically (`EMBEDDING_AUTO_PULL`)
- Embedding batch size and concurrency adapt to measured throughput, with the
  best point remembered and shared across projects using the same embedding
  setup; concurrency climbs up to an implicit ceiling of 8 when unpinned
- **Breaking:** a stamped `INGEST_PIPELINE_CONCURRENCY`,
  `EMBEDDING_TUNE_BATCH_SIZE`, `EMBEDDING_TUNE_MIN_BATCH_SIZE` or
  `EMBEDDING_TUNE_BATCH_TIMEOUT_MS` in a project's registry entry, including
  values `tea-rags tune` wrote, no longer applies; pin one as a per-project
  ceiling with `tea-rags projects set-env --name <alias> KEY=VALUE`, and stored
  throughput optima are re-measured once
- Test files chunk better: setup code is stored once per scope, adjacent
  examples are packed together, and `.tsx` files parse correctly
- Small markdown sections are grouped into sensible chunks instead of tiny
  fragments
- `TRAJECTORY_GIT_ANCHOR=head` measures git windows and ages from HEAD time, so
  pinned historical checkouts no longer index as dormant

### 🗣 Language support

- **_Python_** **call-graph** navigation resolves far more calls: union types,
  re-exports and import aliases, return inference through self-calls, iteration
  and context-manager bindings, descriptors, decorators and container elements
- **_Django_** **call-graph** navigation understands managers, `_meta`,
  relations and `ForeignKey`/`OneToOneField` fields
- **_Ruby_** **call-graph** navigation types more locals, singleton
  constructors, self-returning chains and association names, and stops
  mis-typing self-reassignments

### 🛠 CLI & workflow

- New `llama-server` CLI command prints per-OS launch, model-download
  (`fetch-model`) and autostart instructions
- **MCP** clients get subagent guidance addressed by working directory,
  delivered through the subagent start context

### 🧩 Agent plugin

- Skills and the subagent rule address the caller's working tree and document
  the dense-floor and fallback markers, `pendingFiles` and `indexOnlyFiles`
  rows, and the `find_similar` selection branch
- Skills and the search cascade route diff reviews to `review_changes`, and
  `architecture-diagnostics` gains a layering detector and layer map

### 📚 Documentation

- **Docusaurus:** llama-server provider, multi-GPU guide, measured
  configurations, embedding model comparison and shared throughput optima are
  documented

### 🩹 Fixes

- Each collection now embeds with its registry model rather than the server
  environment's model
- Indexing refuses to run from a process whose build changed on disk, and
  oversized embeddings no longer stall or quarantine documents
- `index-codebase` repair pass and registry stamping no longer lose
  **codegraph** data after a recompute
- **Worktree** diffs no longer write to the user's index, and git children no
  longer take optional locks
- Calls addressed by **worktree** path replay the repository's registry
  environment
- Type resolution for `.jsx` sources and **_Ruby_**/**_Python_** navigation edge
  cases are corrected

### 🔧 Environment Variables

- `EMBEDDING_PROVIDER` · New `llama-server` value embeds through one
  llama-server per GPU with peer and local fallback tiers · default: `unchanged`
  (changed)
- `EMBEDDING_AUTO_PULL` · Automatically pull a missing **Ollama** embedding
  model · default: `true` (new)
- `TRAJECTORY_GIT_ANCHOR` · Measure git windows and ages from `now` or from
  `head` commit time · default: `now` (new)
- `EMBEDDING_BASE_URL` · Endpoint lists accept port shorthand such as
  host:8081,8082 · default: `unchanged` (changed)
- `INGEST_PIPELINE_CONCURRENCY` · Registry-stamped values no longer replay
  unless pinned with `projects set-env`; unset means an implicit climb ceiling
  of 8 · default: `unset (ceiling 8)` (changed)

## [1.45.1](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.45.0...v1.45.1) (2026-09-28)

Maintenance release with no user-facing changes. It supersedes 1.46.0, which was
published by mistake: install 1.45.1 or later.

## [1.45.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.44.2...v1.45.0) (2026-09-27)

### 🔎 Search & ranking

- **Breaking:** `metaOnly` results keep every payload value raw, and every
  search tool carries the labels on `rankingOverlay`. `payload.preset` is gone;
  read `rankingOverlay.preset` instead
- **Breaking:** `level: "file"` results are reduced to file scope. Members and
  chunk-level fields are no longer attached (outline a file with `find_symbol`
  by `relativePath`), and `payload.score` is replaced by the top-level `score`
- Search tools take `fields`, an allow-list of payload paths, and return only
  those fields, which keeps large result sets small
- A response now says when a rerank preset's default `filter` narrowed the
  result set, and names the param that clears it
- Tool schemas list only the filter parameters a tool really applies and
  describe the item shape it really returns

### 🧠 Code intelligence

- New `get_architecture_report` tool: finds convention-privacy leaks, leaking
  abstractions, facade leaks, components in the zone of pain (gated on how
  volatile their git history is), and files that always change together without
  any code link, each explained by the neighbour they share
- **Breaking:** `stableDependencies` findings in `get_architecture_report` are
  judged per component, not per file, and carry component names and
  afferent/efferent counts
- New `get_naming_lexicon` tool: before you name something, it shows the
  project's own vocabulary for that concept, judges a draft name by the role its
  type plays and by the terms it aligns with, and suggests alternatives the
  project already uses
- `get_naming_lexicon` reviews a diff with `changes`: the names a branch
  introduces are checked against the project's vocabulary before merge
- New `get_ontology_report` tool audits a whole codebase's naming: synonyms for
  one concept, generic names, and outliers
- Graph tools and the `find_symbol` outline show each symbol's declared
  visibility, for every native language
- `get_callers` and `get_callees` answer at file scope from the import graph
  when given a file path
- Callers of an inherited member are found through the class that actually
  defines it
- **_TypeScript_** call graph reaches implementers that conform structurally,
  object-literal and factory-returned members, and type-alias contracts
- Test examples are addressable by name in **_TypeScript_**, **_JavaScript_**
  and **_RSpec_**, and `find_symbol` outlines a test file example by example

### ⚡ Indexing & performance

- **Breaking:** `--force --languages` (and `forceReindex` with `languages`)
  re-chunks only the selected files in place and leaves every other point
  untouched, instead of building a new collection of just those languages.
  `--path-pattern`, `--file-extension`, `--test-file` and `--files` narrow it
  further, and drift reports point at this scoped run when only one language's
  chunking changed
- **Breaking:** files above 5000 lines skip chunk-level git churn by default
  (was 10000); file-level git signals are unchanged. Set
  `TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES=10000` for the old limit
- **Ollama** models can be quantized server-side through `OLLAMA_QUANTIZATION`;
  it is opt-in and off by default, and a refused quantization says why

### 🗣 Language support

- **_Swift_** call graph: members are typed through protocols, extensions,
  generics, closures, overloads picked by labels and argument types, SwiftUI
  modifier chains and the Apple SDKs, so navigation in **_Swift_** projects
  reaches much further
- **_JavaScript_** lookup-table dispatch and **_Python_** dict-table dispatch
  show up as call edges
- **_Ruby_** entry-point narrowing follows a hook named by a literal argument

### 🛠 CLI & workflow

- `tea-rags call` runs any **MCP** tool from the command line, in-process, with
  the target project's registered environment
- **Breaking:** the project registry pins only environment values you set
  explicitly, and a newly indexed project starts from code defaults instead of
  inheriting another project's settings. Pins left behind at old release
  defaults are dropped once on upgrade; re-pin one on purpose with
  `tea-rags projects set-env`
- `prime` shows how far each language's chunking, test chunking and call graph
  can be trusted on this index
- `tea-rags qdrant recover` repairs a collection whose optimizer failed
- The `index-codebase --json` report includes the state of each embedding
  endpoint
- `add_documents` accepts an optional metadata schema for typed collections
- `doctor`, `projects`, `update` and `tune` share one coloured output style

### 🧩 Agent plugin

- New `architecture-diagnostics` skill
- Skills name things with the project's own vocabulary: `data-driven-generation`
  runs a naming step, `mr-review` reviews a branch's new names, and naming
  audits go to `get_ontology_report`
- `dinopowers` wrappers check index freshness on reads, route modifications
  through `data-driven-generation` and report root causes
- `report-issue` opens the bug form
- Agent guidance: labels are read from `rankingOverlay`, a split symbol is read
  whole before reasoning about it, file-level import questions go to
  `get_callers` / `get_callees`, visibility is read in graph navigation, and god
  classes are attributed through the file outline

### 📚 Documentation

- **README:** indexing speed on a LAN GPU, the five-layer index with one
  question per layer, a comparison with alternatives, a client and provider
  matrix, and an FAQ
- **Docusaurus:** silent coupling, naming alignment, structural conformance and
  **codegraph** read errors, explicit env pinning, embedding failover and
  hard-kill recovery, the scoped `--force`, the `mr-review` and `report-issue`
  skills, and every ingest error code

### 🩹 Fixes

- Embedding failover: after consecutive failures indexing switches to the
  fallback endpoint, a call caught mid-failover is retried there, and a provider
  that is down at startup fails with an actionable message within its wait
  budget
- A batch that crashes the **Ollama** runner is split and retried at a smaller
  size instead of stalling the run
- A hard-killed index run is reported as `stale_indexing` at once, and the next
  run takes over and reclaims its unfinished build
- `--force-enrichments` fully rebuilds the selected layers, including files
  without chunks and stale skip markers
- Incremental reindexing retries failed deletions, reports partial runs, and
  keeps derived **call-graph** data in step with deleted files
- Git signals follow file renames, and a chunk is credited only for lines a
  commit actually changed
- Chunking keeps doc comments with their symbol, splits oversized symbols on
  statement boundaries, keeps distinct symbols apart in **_TypeScript_** classes
  and bash, and indexes code outside extracted members
- **Call-graph** database files shrink after updates, and a corrupt or locked
  database fails fast with a clear error instead of hanging
- **Call-graph** precision: **_TypeScript_** bare calls bind by lexical scope,
  **_Java_** `new X()` receivers, **_Rust_** type paths, **_Ruby_** mixin order,
  **_Python_** re-exports and same-named classes across languages resolve
  correctly
- **Qdrant** requests survive a reset keep-alive socket, and every filterable
  field gets a payload index on existing collections too
- The **MCP** server releases its resources and exits when the client goes away
- `projects unregister` works for path-registered projects, and
  `projects orphans` counts chunks
- `prime` shows the real status error, and `tune` prints a pasteable **MCP**
  config for any tuned subset
- One-contributor files are labelled `solo` in `recentDominantAuthorPct`, and
  `instability` labels are banded over what the corpus measured

### 🔧 Environment Variables

- `OLLAMA_QUANTIZATION` · Server-side quantization level for the **Ollama**
  embedding model. Opt-in · default: `off` (new)
- `EMBEDDING_TUNE_FAILOVER_CONSECUTIVE_FAILURES` · Consecutive embedding
  failures before switching to `EMBEDDING_FALLBACK_URL`; 0 disables · default:
  `3` (new)
- `TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES` · Files above this many lines skip
  chunk-level git churn · default: `5000` (changed)

## [1.44.2](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.44.1...v1.44.2) (2026-09-23)

### 🩹 Fixes

- Cloning a project into a worktree no longer misreports every language as out
  of date, so it stops recommending an unnecessary full reindex

## [1.44.1](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.44.0...v1.44.1) (2026-09-22)

## [1.44.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.43.1...v1.44.0) (2026-09-22)

### 🔎 Search & ranking

- File and chunk "age"/recency — used in freshness-based ranking, filters like
  `battleTested`, and the values shown in search results — now always reflect
  the current time instead of a stale snapshot from when the file was last
  indexed.
- A new `contributor` filter matches any file a given person has recently
  committed to, filling a gap where the existing `recentAuthor` filter only
  matched files where that person was the single top committer.

### 🧠 Code intelligence

- Indexing the same project from multiple worktrees or checkouts no longer
  causes cross-talk between sessions — each build now gets its own isolated
  codegraph daemon instead of sharing one that could be killed mid-run by
  another session's indexing.

### ⚡ Indexing & performance

- Index freshness checks now detect when the underlying sampling behind ranking
  statistics has changed, and repair the statistics automatically during a
  normal incremental index update instead of leaving outdated numbers in place.
- Indexing now skips Swift/Xcode build artifacts and dependency checkouts
  (`.build/`, `Pods/`, etc.) by default, so a small Swift app's search results
  and rankings aren't diluted by vendored dependency source.

### 🗣 Language support

- Swift is now a supported language for semantic search and call-graph
  navigation — functions, types, extensions, and both XCTest and Quick/Nimble
  test files are chunked and searchable, and call-graph resolution covers
  chained calls (e.g. `self.db.query()`), `super` calls up the superclass chain,
  and receivers typed with `any Protocol` existentials.
- TypeScript call-graph navigation now resolves method calls made on freshly
  constructed objects and on values returned by factory functions (e.g.
  `new Thing().method()`, `createThing().method()`), which previously fell back
  to a file-only match.

### 🛠 CLI & workflow

- `tea-rags doctor --restart` now restarts every running codegraph daemon on the
  machine instead of just one, needed now that multiple daemons can run side by
  side for different builds and worktrees.

### 🩹 Fixes

- Ranking labels for signals like bug-fix rate, churn, and ownership (e.g.
  "healthy"/"critical") are now calculated correctly — covers files with too
  little commit history being mislabeled as maximally risky, test files being
  graded against unrelated source-code statistics, large multi-chunk files
  skewing labels for the whole project, and inverted label boundaries shown in
  index metrics.
- Search results and index metrics for one project no longer show ranking labels
  computed from a different project that was searched earlier in the same
  session.
- Renamed files now keep their correct commit and churn history — a rename could
  previously either drop the file's commit count to zero or misattribute the
  file's entire history to the rename commit alone.
- Indexing's `--json` output now always reports whether enrichment health was
  actually checked, instead of silently omitting the field when it wasn't
  measured.
- TypeScript/JavaScript call-graph navigation resolves substantially more method
  calls to their exact target — including calls through barrel/index re-export
  files and calls whose declaration lives inside a returned object literal from
  a factory or hook function — while no longer misattributing a call to an
  unrelated same-named method elsewhere in the same file.
- Go call-graph resolution is more accurate: type declarations grouped in a
  single `type (...)` block are now all indexed (previously only the first was
  visible), and same-named constructor functions like `New()` declared in
  different packages no longer cross-resolve to each other.
- JavaScript test files are now chunked and labeled as tests the same way
  TypeScript and Ruby files already were, and `.mjs`/`.cjs` files are now
  indexed and searchable — previously they had call-graph data but no searchable
  chunks at all.
- The MCP filters-schema resource no longer names payload fields that were
  renamed or removed, which previously made a raw filter built from that
  documentation silently match nothing.
- Call-graph completeness and reliability: edges to methods that resolve to
  multiple same-file candidates (e.g. multiple interface implementations in one
  file) are no longer silently dropped, concurrent indexing sessions no longer
  kill each other's in-flight codegraph writes, and cloning a project's
  codegraph database (e.g. for a new worktree) is now safe against interruption.

## [1.43.1](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.43.0...v1.43.1) (2026-09-22)

### 🩹 Fixes

- Ruby call-graph navigation (find-callers, impact analysis) now resolves calls
  to `module_function` methods, which previously returned no results

## [1.43.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.42.0...v1.43.0) (2026-09-19)

### ⚡ Indexing & performance

- The first index of a new worktree for an already-indexed repository now seeds
  automatically from a sibling working tree's index — copying what's unchanged
  and only re-embedding what differs — turning a slow first index into a fast
  incremental one, with an opt-out when a from-scratch index is wanted

### 🛠 CLI & workflow

- `doctor --sweep-workers` finds and stops index-worker processes left running
  after a killed CLI command, with a dry-run preview and JSON output for
  scripting
- `prime` now shows how much RAM and page cache an index is using against
  Qdrant's total, with a detailed memory breakdown available in debug mode

### 🩹 Fixes

- Go code search and navigation is significantly more accurate: symbol lookups,
  call resolution, generics, struct embedding, and package imports (including
  build-tag variants and vendored dependencies) now resolve to the correct file
  and package instead of the wrong or no result
- TypeScript and JavaScript code search and navigation resolve calls and imports
  far more accurately: `this`-member calls, interface implementations, and calls
  into base classes outside the project are now correctly attributed; imports
  resolve to the right file for extensionless imports, JSON modules, re-exports,
  and TypeScript's ESM/CJS module extensions
- Search results now honor small limits exactly — asking for 1, 2, or 3 results
  no longer returns 5
- Author and recency filters now do what they claim: filtering by who recently
  touched code (`recentAuthor`) actually filters results instead of being
  silently ignored, age-based filters stay consistent with what's actually
  indexed, and code committed the same day is no longer treated as having no
  date
- Ranking presets and filters behave more predictably: the code-decomposition
  ranking preset again excludes test and block-level chunks by default when
  code-graph ranking is on, an explicit language filter is no longer silently
  narrowed by a preset's own default, and preset defaults no longer exclude the
  caller's own test or documentation files from results
- Fixed stale or fabricated "last modified" dates and code-age values that could
  linger on code after a partial re-index or on a file with no commit history,
  which was throwing off freshness-based ranking and "recently changed" searches
- `rank_chunks` custom ordering now only accepts fields tea-rags actually
  tracks, instead of silently ordering by nothing for an unsupported field; a
  one-time cleanup also removes leftover, unused index structures that were
  wasting disk space and slowing down every write
- `.mts` and `.cts` TypeScript files are now indexed and searchable like other
  TypeScript files — correctly classified as source vs. test, and their imports
  resolve correctly
- Worktree index seeding recovers correctly from interrupted or unreliable runs:
  it resumes a seed whose process died mid-way, refuses to seed from a sibling
  whose own state is incomplete, and never silently treats an unreadable seed
  marker as finished
- Indexing now recovers cleanly when the background code-graph process dies or
  restarts mid-run: a stale connection can no longer read from or write to the
  wrong version of the graph, connections are released instead of leaking, and
  failures report their real cause instead of a generic timeout
- Index-worker processes orphaned by a killed CLI run are now detected and
  cleaned up automatically, and correctly tracked regardless of the system's
  locale settings
- Code-graph indexing no longer produces incomplete or corrupted results under
  concurrent activity: a graph read that overlaps another operation now fails
  and retries instead of silently returning a truncated graph, index rebuilds
  wait for in-flight writes instead of racing them, and a failed batch no longer
  lets other work double-process the same records
- Running one MCP server across multiple projects no longer reports false
  configuration drift, or risks indexing with the wrong settings, when the
  server's own startup environment differs from a project's recorded
  configuration

## [1.42.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.41.0...v1.42.0) (2026-09-16)

### 🧠 Code intelligence

- The call-graph background service now checks compatibility with the service
  it's talking to, and either upgrades automatically or fails with a clear error
  — instead of silently returning incomplete call-graph results when versions
  mismatched

### 🩹 Fixes

- Call-graph lookups like get_callers and get_callees no longer silently return
  stale or empty results after clearing and reindexing a project, or after any
  operation that replaces the underlying call-graph database
- The call-graph background service now keeps the memory limit you configured
  across automatic restarts, instead of silently reverting to the default
- Enabling debug logging (DEBUG=1) for the call-graph background service now
  actually produces log output, instead of staying empty
- Clearing an index now removes all of its call-graph data, so a later reindex
  can no longer reuse call-graph information left over from a previous index
  generation
- Indexing a project is now protected by an exclusive lock, so two indexing runs
  — from different sessions, machines, or an auto-update kicking in mid-run —
  can no longer corrupt each other's progress
- File-path filtering (pathPattern) across all search and ranking tools now
  matches exactly what the glob pattern names, fixing cases that previously
  returned extra files, wrong ordering, or no results at all
- Incremental reindexing of Ruby codebases no longer loses call-graph accuracy
  for ActiveRecord models with custom table names, even when only some files are
  re-walked
- Index status and metrics now report the exact number of searchable code
  chunks, instead of a count inflated by two internal bookkeeping entries
- Call-graph navigation now correctly follows calls made through interface-typed
  variables in TypeScript and JavaScript, instead of guessing a target based on
  method-name uniqueness
- When background code-intelligence indexing hits an internal error, the index
  status now correctly shows as failed instead of hanging as "in progress"
  indefinitely
- find_symbol keeps working with a warning instead of failing outright when the
  call-graph service is temporarily unavailable, such as right after a rebuild
- Documentation table-of-contents entries now link each heading to its own
  section, instead of sometimes jumping to an unrelated one
- Searching for an exact symbol name now reliably surfaces that symbol's own
  code and tests at the top of hybrid search results, instead of unrelated
  look-alikes
- Looking up a documentation section or a class outline now returns clean,
  complete content — without duplicated text, without every test's full body
  attached, and without an empty table of contents in place of the actual
  content
- Ranking signals attached to code chunks, used by presets like hotspot and
  tech-debt detection, are now computed reliably instead of silently defaulting
  to empty for some chunks
- Indexing background workers no longer crash when an indexing run gets
  superseded by a newer one, such as from rapid consecutive indexing requests
- Python call-graph resolution no longer leaks cached results between separate
  indexing runs, which could otherwise produce inconsistent call-graph edges
  depending on run history
- Starting a new index run on a project that's already being indexed, by this
  session or another, is now rejected with a clear error instead of silently
  corrupting the in-progress run
- Index status and metrics for a project now reflect that project's own
  configuration instead of the server's overall settings, so a project with a
  signal type disabled no longer shows data for it
- Fixes a bug where internal index version-tracking metadata could be silently
  overwritten and lost when multiple maintenance operations ran back to back
- Running a signal recompute while a regular indexing sync is still finishing in
  the background no longer causes lost or corrupted code-intelligence data
- Ranking signals for code chunks, like fan-in/fan-out and related hotspot
  scores, are now attributed to the correct function or method instead of
  sometimes being written onto its enclosing function
- The prime command's per-language call-graph resolution stats no longer get
  reset to a single file's numbers after a partial reindex — they keep
  reflecting the whole codebase until the next full recompute
- The CLI's "update available" check now correctly reflects the version you
  actually have installed after an upgrade or relink, instead of showing stale
  information for up to a day
- Fixes indexing runs getting stuck reporting "degraded" forever for projects
  containing files the call-graph analyzer doesn't parse, like JSON, Markdown,
  SQL, or TOML
- Fixes recovery before an automatic reindex silently marking large numbers of
  code chunks as fully analyzed when their call-graph data was actually empty
- Fixes background indexing (enrichment) silently dying partway through on large
  projects, which could leave its status stuck reporting "failed" after a long
  timeout
- The prime command now shows code-quality signal guidance for every major
  language in a codebase, not just the largest one

## [1.41.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.40.0...v1.41.0) (2026-09-13)

📝
[Why this blog exists](https://artk0de.github.io/TeaRAGs-MCP/blog/why-this-blog-exists)
— The changelog tells you what shipped. It does not tell you why a ranking
signal was added, which three hypotheses died before the fourth one held, or
what the numbers looked like before and after…

### 🧠 Code intelligence

- TypeScript/JSX call-graph navigation (find-callers, trace_path, find-similar)
  no longer merges unrelated symbols that share a name across different files,
  correctly follows re-exports and components wrapped with memo/forwardRef, and
  keeps working through codegraph service restarts

### ⚡ Indexing & performance

- Search results, prime, and get_index_status now surface one unified freshness
  report instead of several disconnected checks — flagging when the index falls
  behind the current commit, when environment variables or language-parser
  versions changed since the index was built, and what to run to fix it
- tea-rags now detects when an embedding model's weights changed even though its
  name stayed the same, and refuses to mix the incompatible vectors into the
  index instead of silently corrupting search results
- The background index-repair pass is more reliable: it retries failed writes
  without losing progress, correctly re-repairs symbols whose metrics changed,
  and no longer skips files that have no symbols or that a provider can't store
- Fixed index migrations that could leave call-graph parent-symbol links missing
  on some indexes, or clear one freshness marker while writing another

### 🗣 Language support

- Call-graph navigation for Python now follows multiple base classes in Python's
  real method-resolution order — including through super(), class-level
  receivers, and dynamically computed base classes — instead of guessing or
  giving up
- Python symbol resolution now follows bare calls, package re-exports, module
  and class aliases, and module-level receivers to their real definitions across
  files, instead of leaving them unresolved or matching the wrong one
- Python call-graph accuracy improved for typed and dynamically-dispatched code:
  fields, return values, and receivers are now typed from constructors, type
  annotations, Google/Sphinx-style docstrings, naming conventions, and
  framework-specific patterns like Django model managers and SQLAlchemy models

### 🛠 CLI & workflow

- tea-rags projects prune now sweeps registry entries whose project directory no
  longer exists, and its --dry-run footer correctly names what it would do

### 🩹 Fixes

- Project path resolution is now consistent across every tool surface — the same
  directory, including worktrees, always maps to the same registered project
- Fixed a race where saving the project registry could overwrite recent changes
  made by another process instead of merging them
- Ruby call-graph resolution no longer matches constants or short names defined
  in a different language's files within the same project
- Index status now shows the health of every enrichment provider currently
  active, not just the most recently run one
- Fixed reindex phase timing (--wait-enrichments) misattributing the sync step's
  time to the embedding phase
- tea-rags projects unregister --purge and project teardown now remove every
  generation of a project's artifacts, not a partial set
- Background auto-update runs now keep the project's registry identity, and the
  registry's last-synced timestamp updates even when a sync only deletes files
- Fixed a cleanup pass that could delete live call-graph data for a project
  while only meaning to remove stale, unrelated files
- Fixed incremental call-graph updates that could resolve symbols against a
  stale registry instead of the shared, up-to-date one
- find_symbol no longer matches a file whose path merely starts with the
  requested path — only exact matches now
- Fixed indexing sometimes reporting completion before file counts had fully
  settled

## [1.40.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.39.0...v1.40.0) (2026-08-15)

### ⚡ Indexing & performance

- Indexing gained --force-enrichments, which rebuilds enrichment data (git and
  codegraph signals) without re-running embeddings — turning a full reindex's
  hours into a minutes-long recompute when only enrichment logic changed.
- Both --force and --force-enrichments now accept --languages, so a rebuild can
  target a single language's payload instead of the whole project.
- Indexing supports an opt-in --cpu-prof flag on enrichment worker threads, for
  profiling slow indexing runs.
- Schema-drift warnings now name the exact rebuild command needed — enrichment
  recompute vs. a full reindex — instead of always demanding a full reindex.

### 🗣 Language support

- TypeScript call-graph resolution now understands types, not just syntax: union
  and narrowed receivers, structural/duck-typed and merged-interface receivers,
  generics and overloads, inferred return types, and JSX component tags all
  resolve to their real targets — closing gaps where call-graph tools
  (find_callers, trace_path, blast_radius) silently dropped or misattributed
  these calls.
- TypeScript call-graph extraction now also picks up CommonJS require() imports,
  barrel re-exports, computed-property calls (obj['foo']()), .call/.apply/.bind
  indirection, and methods passed as callback values — patterns it silently
  missed before.
- Call-graph resolution can now defer a weak match to a later, more precise pass
  instead of committing early, recovering call edges that used to be dropped
  outright.
- Large TypeScript codebases' codegraph resolution now exposes its parse-cache
  size and memory budgets as environment variables, letting hosts tune resource
  usage to their repository size.

### 🩹 Fixes

- Dozens of TypeScript call-graph correctness fixes — bare/global calls,
  destructured and untyped receivers, node_modules noise, tsconfig path mapping,
  barrel/index re-exports, and resolving imports against the right project root
  all used to fabricate, misattribute, or drop call edges.
- Fixed TypeScript codegraph resolution memory/stability issues so long-running
  or repeated indexing doesn't grow caches unbounded, and a failed parse
  degrades gracefully instead of crashing the run.
- Fixed several bugs in --force-enrichments and --force where forced rebuilds
  silently skipped work, ran extraction twice, refused to combine with
  --languages, or left a half-built collection behind after a failed rebuild.
- Fixed multiple codegraph-storage reliability bugs that could crash a rebuild,
  silently drop or duplicate call-graph data, leave a stuck lock behind after a
  killed process, or discard the daemon's own crash diagnostics — including a
  case where find_cycles reported no cycles for a project that had them.
- Fixed several code-chunking and symbol-naming bugs for JS/TS — nested class
  members, const-object namespaces, and certain exports now chunk and name
  correctly instead of producing duplicate, missing, or misnamed search results.
- Fixed Ruby call-graph type inference wrongly attributing ActiveRecord
  association types (has_many, belongs_to, etc.) to methods where those macros
  don't actually apply — they're class-body-only declarations.
- Server startup no longer logs a spurious "failed to obtain server version"
  warning against Qdrant.
- Fixed file-level search rankings occasionally being skewed by one arbitrary
  method's call-graph centrality score instead of being scored neutrally.

### 🔧 Environment Variables

- `CODEGRAPH_TS_PROGRAM_CACHE_MAX` · Max number of cached TypeScript codegraph
  programs retained across resolution runs · default: `8` (new)
- `CODEGRAPH_TS_PROGRAM_PARSED_FILES_MAX` · Max project source files parsed into
  a single TypeScript codegraph resolution program · default: `20000` (new)
- `CODEGRAPH_TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX` · Max dependency (.d.ts)
  files parsed into a TypeScript codegraph resolution program · default: `8000`
  (new)
- `CODEGRAPH_TS_PROGRAM_RETAINED_TEXT_MB` · Max source text retained in memory
  by the TypeScript codegraph resolution cache · default: `256` (new)
- `CODEGRAPH_TS_PROGRAM_STRATEGY` · How TypeScript codegraph resolution builds
  its type-checking program: whole-project, per-entry-file coverage, or
  auto-selected · default: `auto` (new)
- `CODEGRAPH_TS_PROGRAM_WHOLE_ROOT_MAX` · Max tsconfig root file count before
  falling back to per-entry-file resolution instead of a whole-project program ·
  default: `20000` (new)
- `CODEGRAPH_TS_PROGRAM_WHOLE_MIN_ENTRIES` · Min distinct files a run must touch
  before building a whole-project TypeScript program · default: `200` (new)
- `ENRICHMENT_WORKER_MEMORY_LIMIT_MB` · Per-worker memory ceiling for enrichment
  worker threads · default: `6144` (changed)

## [1.39.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.38.1...v1.39.0) (2026-08-09)

### 🗣 Language support

- Ruby call-graph and type resolution now follow mixins (`include`, `extend`,
  `prepend`) declared inside class-body blocks such as `included do ... end` —
  the common ActiveSupport::Concern pattern — so classes that use concerns
  resolve their full ancestry.

### 🩹 Fixes

- Fixed indexing failures caused by an incorrect embedding vector width — covers
  tagged Ollama model names, models missing from the built-in size table,
  providers (Cohere, Voyage) with no model-info API, and downstream artifacts
  sized from a stale guess instead of the real width.
- `tea-rags tune` now actually writes its measured settings to the project
  registry and correctly resolves a project's embedding endpoint overrides, so
  tuned values are no longer silently discarded or overridden by stale defaults.
- Fixed `index-codebase` failing to connect to an embedded Qdrant daemon after a
  stale port was left behind by an older release.
- Concurrent or background reindex runs no longer delete an in-progress
  collection out from under each other, which could silently corrupt or kill
  another run's index.
- The MCP server and CLI no longer hang for several seconds on startup when the
  embedding endpoint is unreachable.
- Restored ranking overlay signals (method centrality, hotspot, and related
  metrics) that had gone missing from several rerank presets, including
  criticalMethod, hotMethod, godMethod, blastRadius, and entryPoint.
- Ruby associations (`has_many`, `has_one`, `belongs_to`, etc.) declared inside
  a method body are no longer mistakenly attributed to the enclosing class,
  which was causing incorrect type resolution for calls on those objects.

## [1.38.1](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.38.0...v1.38.1) (2026-08-07)

### 🩹 Fixes

- Fixed a bug where git-derived signals (recency, churn, ownership) could
  silently go missing from indexed results when the embedding model used a
  non-standard vector size — indexing now matches the collection's actual
  dimensions instead of guessing from a static model list

## [1.38.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.37.0...v1.38.0) (2026-08-07)

### 🔎 Search & ranking

- File-level search results now include an outline of what matched inside each
  file — the symbols or headings that hit, in the same shape find_symbol returns
  — instead of just telling you the file matched.
- Semantic search results now carry a confidence label (high/medium/low) for how
  well they actually match your query, calibrated against the collection's own
  score distribution — a low label is a signal the answer may not be in the
  codebase at all.
- The bugHunt ranking preset now also factors in call-graph centrality, so among
  equally bug-prone methods it favors the one the rest of the codebase actually
  depends on.
- Four new ranking presets use the call graph to spot risky code: hotMethod and
  godMethod rank by how many callers a method has or how many collaborators it
  reaches, criticalMethod ranks by how central a method is across the whole call
  graph, and criticalPath combines centrality with churn and bug history to flag
  methods that are both critical and unstable — a good pre-release QA scan.

### 🧠 Code intelligence

- Ruby call-graph navigation resolves more methods correctly when a `@return`
  type annotation doesn't spell out its full namespace, by qualifying it against
  the scope it was written in.

### ⚡ Indexing & performance

- If you're on an existing index, the search-confidence signal now backfills
  automatically on your next reindex instead of requiring a full rebuild for it
  to show up.

### 🛠 CLI & workflow

- Added an opt-in auto-update watcher: turn it on via the CLI and tea-rags
  re-indexes a project in the background whenever its tracked branch gets new
  commits, with status visible in the session digest, the auto-update status
  command, and a hint on search results when a refresh just kicked off.
- Added an mr-review skill for Claude Code that runs a structured,
  multi-dimension code review — blast radius, style consistency, fragile zones,
  test coverage, invariants, cycles — and posts the results as a PR comment.

### 🩹 Fixes

- Auto-update now notices when it's turned on after the MCP server already
  started, instead of requiring a reconnect before it activates.
- Re-running an index on a repo with no file changes now also repairs corrupted
  call-graph data if it finds any, instead of only checking for repairs when
  files actually changed.
- Indexing a project through the MCP server now uses that project's own saved
  settings (chunk size, concurrency, batch size, etc.) instead of silently
  falling back to the server's defaults.
- The risk-assessment skill no longer lets test files and docs crowd out
  production code in its scan, and its test-coverage check no longer produces
  false "untested" warnings when different parts of the codebase share similarly
  named tests.

## [1.37.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.36.0...v1.37.0) (2026-08-02)

### 🔎 Search & ranking

- New named filter presets — pass, for example, `{ presets: "godMethods" }` to a
  search/rank tool instead of writing raw filter JSON. Presets cover common
  code-quality investigations: security-sensitive paths and core production
  logic, high-churn/high-risk files from git history (freshLegacyEdits,
  fragileSilo, panicZone, godMethods), call-graph structure (hubs, dead-code
  candidates, unstable core), and composite investigations (battle-tested code,
  abandoned hotspots). Available preset names are discoverable directly from the
  tool's schema.
- Two new ranking presets help find structurally risky code directly:
  decomposition surfaces outsized files and classes that are candidates for
  splitting up, and godModule surfaces files with too many symbols, weighted by
  how much of the codebase depends on them when call-graph data is available.
- Size-based rankings (e.g. finding oversized files or classes) now also honor
  fixed, per-language industry-standard size limits (such as ESLint's 300-line
  guideline or RuboCop's 100-line class limit) as a floor under the
  project-relative percentile, so a genuinely bloated file is flagged as large
  even on a codebase where everything is oversized.

### 🧠 Code intelligence

- Ruby call-graph resolution now recognizes variables named after their class —
  Rails' dominant naming convention (e.g. `user`, `actor`, `client`) — and
  resolves method calls on them accordingly, instead of leaving them unresolved.
- Ruby call-graph resolution now understands methods documented as returning
  either a type or nil (e.g. ``@return` [Firm, nil]`), instead of dropping that
  information and leaving the call unresolved.
- Call-graph data now self-repairs on every incremental reindex: files whose
  graph rows have drifted out of sync with the code are automatically detected
  and re-extracted, instead of accumulating stale or missing call-graph data
  indefinitely. This also fixes a bug that made every incremental reindex
  silently re-parse the entire repository instead of just the drifted files.

### 🗣 Language support

- Ruby call-graph resolution now understands common Rails-ecosystem gem
  conventions — Devise's scoped current-user-style accessors, CanCanCan
  authorization checks, Draper decorators, ActiveModelSerializers pass-through
  attributes, Kaminari and will_paginate pagination chains, Ransack search
  chains, and dry-initializer declared readers — instead of treating the values
  they return as untyped.

### 🩹 Fixes

- Fixed two bugs in call-graph enrichment tracking: files excluded by custom
  exclusion patterns no longer get stuck reporting a permanent "degraded" status
  on every incremental reindex, and files skipped during a run are now marked as
  skipped immediately instead of one run later.
- Call-graph short-name lookups (used by tools like find_callers) now correctly
  resolve compactly-namespaced class declarations (e.g. `Module::Class`),
  instead of returning no results for them.
- Ruby call-graph resolution now follows Ruby's real method-resolution order
  across mixins and multi-level inheritance — `super` calls, inherited
  return-type facts, and ambiguous method lookups now resolve to the correct
  ancestor instead of sometimes picking a farther-away superclass over a nearer
  mixin.
- Ranking overlay labels (e.g. distinguishing an ordinary file from a "hub" or
  an oversized "god module") now render correctly for several structural signals
  that previously showed as unlabeled raw numbers.
- Call-graph queries (like get_callers) no longer hang indefinitely when the
  background call-graph process has gone idle — they now fail fast and reconnect
  automatically on the next call.
- Cloning a project's call-graph index (e.g. for a git worktree) no longer
  silently loses recently-computed data such as fan-in and centrality scores.
- Call-graph tools (get_callers, get_callees, find_cycles) now report an error
  when the underlying graph can't be read, instead of silently returning an
  empty result that looks identical to "this symbol truly has no callers."
- Indexing a git worktree no longer silently falls back to an unreachable
  default embedding endpoint — it now inherits the same embedding configuration
  as its main checkout.
- Fixed a case where the recovery phase of an incremental reindex could fail to
  enrich files with call-graph data because the background call-graph process
  wasn't being kept alive for that phase.
- Large call-graph query responses now decode dramatically faster (up to roughly
  150x on multi-megabyte results), and non-ASCII identifiers in those responses
  no longer get corrupted.
- Disk space used by orphaned call-graph database files left behind by renamed
  or aliased projects is now reclaimed automatically.
- Incrementally reindexing a renamed (aliased) project no longer risks writing
  call-graph data into the wrong underlying collection.
- Indexing a git worktree now inherits its main checkout's index settings
  (embedding backend, chunk size, call-graph config) instead of borrowing
  whatever project happened to be indexed most recently.
- Indexing a fresh git worktree of an already-indexed repository now reuses the
  existing git-blame cache instead of rebuilding it from scratch.

### 🔧 Environment Variables

- `CODEGRAPH_EXCLUDE_TESTS` · Removed — codegraph indexing now always excludes
  test files (this was already the default behavior); setting this variable no
  longer has any effect. · default: `true (fixed, no longer configurable)`
  (changed)
- `CODEGRAPH_BULK_FILES` · Batch size for call-graph pass-2 file writes, for
  tuning throughput on large repositories. · default: `256` (new)
- `CODEGRAPH_CHECKPOINT_EVERY` · How often (in files) the call-graph pass-2
  writer checkpoints to disk. · default: `500` (new)

## [1.36.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.35.0...v1.36.0) (2026-07-28)

### 🧠 Code intelligence

- Ruby call-graph navigation resolves more callers correctly — through memoized
  reader methods, bare self-calls, ActiveRecord associations and query methods,
  schema-declared column accessors, constructor arguments, rescue-clause
  exception variables, and `super` calls through mixin hierarchies
- Call-graph navigation follows Rails service-object call chains (e.g.
  `Create.call(x).successful?`) to their exact target instead of a broad guess
  across every same-named method
- Caller and impact lookups (get_callers, blast-radius) now redirect calls on an
  abstract base method to the concrete override that actually runs — including
  through typed instance variables and across incremental re-indexes

### 🩹 Fixes

- Ruby call-graph navigation recognizes methods defined via `class << self` or
  inside `included do ... end` blocks, resolves registry-style dispatch and
  constant-rooted method chains, respects file-exclusion rules on a forced
  re-index, and no longer returns phantom matches from post-deployment migration
  scripts
- Call-graph results no longer follow incorrect type information — a YARD
  documentation block leaking onto the wrong method, a generic return-type guess
  overriding an already-known receiver, or a documented return type that names
  no real class in the project
- Incremental indexing reports accurate progress instead of an underestimated
  whole-repo count, worker crashes surface the actual error instead of failing
  silently, and enrichment recovery heals every unenriched file instead of
  stopping after the first 10,000

## [1.35.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.34.1...v1.35.0) (2026-07-08)

### 🧠 Code intelligence

- Ruby call-graph navigation (get_callers/find_callers) now resolves calls
  dispatched through a shared abstract method invoked via self — including the
  common two-hop `ClassName.call -> new.call` service-object delegation pattern
  — instead of returning no results for these call sites.

### ⚡ Indexing & performance

- Incremental reindexing now updates git-derived file signals (age, churn,
  ownership) incrementally instead of re-scanning the full git history on every
  run, including on repositories with rebased or merged branch history — making
  incremental reindexes on large repos noticeably faster.
- Indexing no longer stalls the whole run while computing git blame on
  repositories with deep file histories — blame is now computed off the main
  thread, with a new tunable concurrency knob for large monorepos.

### 🛠 CLI & workflow

- Setup now asks which git history engine to use for indexing — the standard git
  CLI or a faster in-process alternative (recommended automatically for very
  large repositories) — configurable per project via a new GIT_ADAPTER setting,
  and `tune` reports which engine is active.
- `tea-rags tune --project` now saves the performance settings it measures
  directly into the project's configuration, so future indexing runs pick them
  up automatically instead of requiring the generated .env file to be copied in
  by hand.
- The CLI indexing progress display now reports code-graph write progress
  instead of appearing to stall near the end of a run.

### 🩹 Fixes

- Code intelligence results (e.g. get_callers) could silently miss up to 255
  files' symbols after a full reindex — the call graph now captures every file's
  symbols instead of dropping a batch's remainder.
- Call-graph results for Ruby code no longer include meaningless noise entries
  from call chains rooted in external libraries.
- Indexing very large repositories no longer risks running out of memory during
  git-history enrichment — concurrent batches previously each triggered their
  own full git-history scan, and a hidden concurrency floor ignored lower
  concurrency settings meant to bound memory use.
- Indexing large repositories no longer fails with a false timeout while
  scanning git history — the timeout now resets on activity instead of capping
  total duration, so long-but-alive scans (including ones with a single giant
  commit) complete instead of being killed.
- The embedded Qdrant daemon now self-heals when a previous interrupted reindex
  leaves behind a corrupted collection, instead of permanently failing to start.
- `tea-rags tune --project` now works on projects using the embedded Qdrant
  daemon — previously it failed immediately, either erroring while the daemon
  was still starting up or misresolving the embedded connection address.
- CLI indexing commands now wait for the embedded Qdrant daemon to finish
  recovering after a restart instead of failing immediately, and --json output
  now reports the actual error instead of exiting silently with no output.
- A reindex run with no environment variables set now reproduces the project's
  last configured indexing settings instead of silently falling back to code
  defaults.
- Incremental reindexing now automatically cleans up leftover data from previous
  interrupted full reindexes, instead of it accumulating until the next
  successful one.
- Interrupting an indexing run (Ctrl-C) now fully stops its git subprocesses
  instead of leaving orphaned git processes running in the background.

### 🔧 Environment Variables

- `GIT_ADAPTER` · Selects the git history engine used for indexing: the standard
  git CLI or a faster in-process es-git library (auto-recommended for very large
  repositories) · default: `git` (new)
- `TRAJECTORY_GIT_BLAME_POOL_SIZE` · Number of worker threads used to compute
  git blame off the main thread during indexing · default: `min(4, cpus - 1)`
  (new)
- `TRAJECTORY_GIT_CHUNK_CONCURRENCY` · Number of concurrent git-blame operations
  during chunk-level enrichment; a hidden floor that kept this at a minimum of
  10 was removed, so lower values are now honored · default: `10` (changed)
- `TRAJECTORY_GIT_LOG_TIMEOUT_MS` · Now an inactivity window that resets on any
  output, instead of a hard cap on the total duration of the bulk git-history
  scan · default: `60000` (changed)

## [1.34.1](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.34.0...v1.34.1) (2026-07-04)

### 🩹 Fixes

- Indexing no longer crashes if the git process behind it exits unexpectedly
  mid-scan

## [1.34.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.33.0...v1.34.0) (2026-07-04)

### 🧠 Code intelligence

- Ruby call-graph resolution now narrows ambiguous, duck-typed method calls
  using call-site evidence — argument count, keyword arguments, block usage, and
  literal receiver types — so calls that previously fanned out to dozens of
  unrelated methods now resolve to far fewer, more precise targets; navigation
  tools (get_callers/get_callees) also hide the low-confidence leftovers.
- Ruby call-graph resolution now follows self-sends inside class bodies and
  callbacks, methods defined via included concerns/modules, `super` across
  module hierarchies, namespaced and inherited classes, and
  Sidekiq/ActiveJob-style enqueue dispatch — call sites that previously resolved
  to nothing (or to the wrong same-named method elsewhere) now resolve
  correctly.
- An ambiguous method call reachable from hundreds of classes is now capped and
  tracked as its own category instead of flooding the call graph with hundreds
  of thousands of low-value edges, and fan-in/importance rankings are weighted
  by resolution confidence so ambiguous calls no longer manufacture fake
  'most-connected' methods.
- Ruby dynamic-dispatch resolution now also narrows candidates by which classes
  are actually instantiated elsewhere in the codebase, not just structurally
  reachable ones — another layer of precision for ambiguous method calls.
- Rails framework conventions — Sidekiq/ActiveJob enqueueing, callbacks, `enum`,
  AASM state machines, `Concern` class methods, Pundit policies, routing, and
  caching — are now modeled as real call-graph edges instead of being invisible
  to code navigation.
- The code-graph daemon now temporarily raises its own memory ceiling during
  large bulk-index writes to avoid running out of memory, and automatically
  restarts itself after tea-rags is upgraded instead of silently continuing to
  serve results from the old version.
- get_callers can now optionally include ambiguous dynamic-dispatch call sites
  that might reach a target method, on request, without cluttering the default
  result set.

### ⚡ Indexing & performance

- The vector index now uses 8x quantization (TurboQuant) by default for a
  smaller on-disk footprint — new collections are created with it, existing
  collections auto-migrate on startup, indexing shows migration progress, and
  search results are automatically rescored so accuracy is unaffected.
- A new low-memory mode keeps the embedded Qdrant index on disk instead of in
  RAM for memory-constrained machines, plus an optional strict memory ceiling
  and search-batch-size cap to prevent Qdrant from running out of memory.
- Indexing now marks a stalled enrichment stage as failed after 15 minutes of no
  progress instead of showing 'in progress' forever, so status reporting
  reflects reality and a fresh reindex can recover.
- CLI reindexing and the session digest now automatically pick up the same
  performance-tuning settings the MCP server used when a project was first
  indexed, instead of silently falling back to defaults in a fresh shell.

### 🗣 Language support

- Ruby/Rails DSL detection (Sidekiq, CarrierWave, AASM, state_machines,
  PaperTrail, Geocoder, dry-rb, Chewy, ActiveModelSerializers, and more) now
  activates per project based on the gems actually declared in its Gemfile,
  instead of applying every framework's rules to every Ruby project — fewer
  false call-graph edges from gems a project doesn't use.
- Ruby type inference now follows memoized (`||=`) instance-variable and
  local-variable assignments, relation-to-collection conversions, element access
  on identifiers, and a fuller set of ActiveRecord finder/query methods — more
  accurate types mean more call-graph targets resolve correctly.
- Ruby type inference now types instance variables assigned from a parameter,
  local variable, or association chain, and follows YARD `@param` documentation
  to seed `Const.new` call chains as typed instances.
- Rails database migration and data scripts (db/migrate, db/data) are now
  excluded from Ruby call-graph analysis, so they no longer count as unresolved
  code and skew code-intelligence results for a project.
- The README and docs now show a generated, always-accurate language support
  matrix — per-language code-intelligence and test-tooling capabilities —
  instead of a hand-maintained table that could drift from what's actually
  shipped.

### 🛠 CLI & workflow

- get_index_status now reports the index's on-disk size, vector quantization
  mode, and the running Qdrant server version.
- tea-rags now requires Qdrant 1.18.2 or newer; an older external Qdrant server
  is rejected at startup with a clear error instead of failing unpredictably,
  and the embedded daemon auto-updates to the required version.
- Worktree index lifecycle is now explicit and visible: creating a worktree
  clones its index, each completed task step reindexes it, and merging or
  abandoning the branch automatically tears the clone down — replacing the
  previous implicit auto-reindex-on-commit behavior.
- The session-start digest now shows a one-line summary of which embedding,
  Qdrant, and codegraph settings are actually active for a project.

### 🩹 Fixes

- Fixed several Ruby call-graph resolution bugs: namespaced base classes and
  included concerns weren't matched correctly (so self-sends inside them
  silently failed to resolve), a namespaced method could incorrectly match a
  same-named method in an unrelated class, a compact class declaration
  (`class A::B::C`) could fabricate a nonexistent external base class,
  destructured or multiple-assignment local variables were mistaken for method
  calls, and a method marked `private` via `private :name` after its definition
  was incorrectly treated as public.
- Fixed find_symbol returning no results for Rails DSL-defined symbols (`scope`,
  `has_many`, `delegate`) even though they were reachable through code
  navigation.
- Fixed find_symbol on a large method split into multiple chunks returning
  several conflicting results instead of one merged definition.
- Fixed YARD `@param` type parsing to also support the bracket-first form
  (``@param` [Type] name`) used by Rails/mastodon-style docs, so more
  instance-variable types resolve correctly.
- Fixed indexing aborting entirely on a brief Ollama outage mid-run — indexing
  now retries with backoff and survives transient unavailability instead of
  losing all progress.
- Fixed the embedded Qdrant daemon continuing to serve the old version
  indefinitely after a binary auto-upgrade — the stale daemon is now restarted.
- Fixed indexing failing with 'Qdrant is not reachable' for older projects after
  the embedded Qdrant daemon restarted on a new port.
- Fixed indexing status getting stuck showing an enrichment stage as crashed
  even after it had already recovered on a later reindex.
- Fixed reported index disk size being several times too large, or missing
  entirely, by counting actual disk usage instead of preallocated space.
- Fixed indexing from a worktree clone, or from a fresh shell, sometimes
  crashing or connecting to the wrong Qdrant instance by correctly inheriting
  embedded-Qdrant connection settings.

### 🔧 Environment Variables

- `QDRANT_TURBO_QUANT` · Enables 8x vector quantization (TurboQuant) to shrink
  the on-disk index while search results are automatically rescored to preserve
  accuracy · default: `true` (new)
- `CODEGRAPH_DB_MEMORY_LIMIT_MAX` · Ceiling the code-graph daemon may
  temporarily raise its memory limit to during large bulk-index write bursts ·
  default: `4GB` (new)
- `QDRANT_LOW_MEMORY` · Forces the embedded Qdrant daemon to keep vectors and
  payloads on disk instead of in RAM, for memory-constrained machines · default:
  `false` (new)
- `QDRANT_MAX_RESIDENT_MEMORY_PERCENT` · Optional strict-mode ceiling on
  Qdrant's resident memory usage, to guard against out-of-memory crashes ·
  default: `unset (guard off)` (new)
- `QDRANT_SEARCH_MAX_BATCHSIZE` · Optional cap on the number of vectors a single
  search batch may process · default: `unset (no cap)` (new)
- `EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS` · Maximum time indexing keeps
  retrying embedding calls through a transient Ollama outage before giving up ·
  default: `240000 (4 minutes)` (new)
- `EMBEDDING_TUNE_UNAVAILABLE_RETRY_BASE_DELAY_MS` · Base backoff delay between
  embedding retry attempts during an Ollama outage · default: `2000` (new)
- `ENRICHMENT_STALL_DEADLINE_MS` · How long an enrichment stage may report no
  progress before indexing status marks it failed (and eligible for recovery on
  the next reindex) · default: `900000 (15 minutes)` (new)
- `TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT` · Overrides the build fingerprint the
  codegraph daemon and client exchange to detect a stale daemon after an upgrade
  · default: `derived automatically from module path, version, and mtime` (new)
- `TRAJECTORY_GIT_CHUNK_CONCURRENCY` · Git chunk-churn walk concurrency; a
  configured value below the built-in default is now ignored, so this env var
  can only raise concurrency, never silently lower it · default: `10` (changed)

## [1.33.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.32.0...v1.33.0) (2026-06-26)

### api

- index-codebase --name registers a project alias before forking the worker,
  aborting with typed text or JSON errors on validation failure
  ([28d142f](https://github.com/artk0de/TeaRAGs-MCP/commit/28d142f),
  [51e7cfb](https://github.com/artk0de/TeaRAGs-MCP/commit/51e7cfb))
- worktree create/list/remove/info methods exposed on App
  ([c7a0125](https://github.com/artk0de/TeaRAGs-MCP/commit/c7a0125))

### cli

- project exist command for registry membership guard
  ([7dcc41f](https://github.com/artk0de/TeaRAGs-MCP/commit/7dcc41f))
- worktree create/list/remove/info command group
  ([2239d32](https://github.com/artk0de/TeaRAGs-MCP/commit/2239d32))

### contracts

- RubyTypeRef and type-source interfaces added to contracts; ivarTypes and
  structuredReturnTypes added to CallContext for the type-propagation engine
  ([3a5abcf](https://github.com/artk0de/TeaRAGs-MCP/commit/3a5abcf),
  [4c373ba](https://github.com/artk0de/TeaRAGs-MCP/commit/4c373ba))
- member-aware external classification for AR-core members added to
  ExternalVocabulary
  ([41a6703](https://github.com/artk0de/TeaRAGs-MCP/commit/41a6703))

### dinopowers

- finishing-branch flow updated with post-merge cleanup step: worktree remove
  via CLI and hook-driven reindex
  ([89e156d](https://github.com/artk0de/TeaRAGs-MCP/commit/89e156d))

### factory

- CollectionFootprintFactory and WorktreeOps wired into App bootstrap
  ([3be7169](https://github.com/artk0de/TeaRAGs-MCP/commit/3be7169))

### ingest

- fix: gitignore whitelist patterns correctly descend into subdirectories when
  directory entries are probed with a trailing slash
  ([90d8bd8](https://github.com/artk0de/TeaRAGs-MCP/commit/90d8bd8))

### maintenance

- worktree maintenance domain: footprint kernel, artifact clone methods,
  registry provenance fields, and transactional WorktreeOps create-saga with
  provenance-guarded remove
  ([6cc22ec](https://github.com/artk0de/TeaRAGs-MCP/commit/6cc22ec),
  [02607b2](https://github.com/artk0de/TeaRAGs-MCP/commit/02607b2),
  [252900d](https://github.com/artk0de/TeaRAGs-MCP/commit/252900d),
  [6fec406](https://github.com/artk0de/TeaRAGs-MCP/commit/6fec406))
- fix: worktree saga correctness: collection collision guard before clone,
  rollback of git worktree and cloned artifacts on saga failure, codegraph clone
  by physical version, and cloneDatabase target dir guard
  ([17f90ff](https://github.com/artk0de/TeaRAGs-MCP/commit/17f90ff),
  [e22b2ec](https://github.com/artk0de/TeaRAGs-MCP/commit/e22b2ec),
  [ccdf57d](https://github.com/artk0de/TeaRAGs-MCP/commit/ccdf57d),
  [38a0dbd](https://github.com/artk0de/TeaRAGs-MCP/commit/38a0dbd))

### mcp

- reindex_changes MCP tool removed; index_codebase auto-detects changed files
  and performs incremental updates
  ([961af5a](https://github.com/artk0de/TeaRAGs-MCP/commit/961af5a))

### pipeline

- fix: WorkerDispatchPool.dispatch bounded by per-worker liveness timeout with
  automatic worker respawn on expiry, preventing pool wedge from hung
  tree-sitter workers
  ([103a7ea](https://github.com/artk0de/TeaRAGs-MCP/commit/103a7ea))

### qdrant

- QdrantManager gains createSnapshot, recoverFromSnapshot, and deleteSnapshot
  for collection clone via snapshot-recover lifecycle
  ([db4b6e2](https://github.com/artk0de/TeaRAGs-MCP/commit/db4b6e2))
- fix: snapshot create and recover failures throw typed QdrantOperationError
  instead of plain Error
  ([10310d3](https://github.com/artk0de/TeaRAGs-MCP/commit/10310d3))

### tea-rags

- post-commit and post-merge auto-reindex hook registered as PostToolUse:Bash
  trigger ([dfc4a48](https://github.com/artk0de/TeaRAGs-MCP/commit/dfc4a48),
  [48b1061](https://github.com/artk0de/TeaRAGs-MCP/commit/48b1061))
- fix: auto-reindex hook reads canonical .tool_response payload key, fixing dead
  success/failure guard that caused reindex on every git commit including
  failures ([111fb11](https://github.com/artk0de/TeaRAGs-MCP/commit/111fb11))

### trajectory

- Ruby receiver type-propagation engine resolves types through single- and
  multi-hop call chains via TypeFactStore with source precedence and
  union/container normalization
  ([20d6d31](https://github.com/artk0de/TeaRAGs-MCP/commit/20d6d31),
  [e4b476f](https://github.com/artk0de/TeaRAGs-MCP/commit/e4b476f),
  [9d03b86](https://github.com/artk0de/TeaRAGs-MCP/commit/9d03b86),
  [39c9d7e](https://github.com/artk0de/TeaRAGs-MCP/commit/39c9d7e),
  [72adc4d](https://github.com/artk0de/TeaRAGs-MCP/commit/72adc4d),
  [d14795a](https://github.com/artk0de/TeaRAGs-MCP/commit/d14795a))
- union receiver types fan out to typed members; container receivers propagate
  element type through blocks and index access; exotic YARD tags (@type,
  @!attribute, @option) contribute type facts
  ([176dff6](https://github.com/artk0de/TeaRAGs-MCP/commit/176dff6),
  [8d48950](https://github.com/artk0de/TeaRAGs-MCP/commit/8d48950),
  [d4cff93](https://github.com/artk0de/TeaRAGs-MCP/commit/d4cff93))
- ActiveRecord core instance-member vocabulary identifies AR members as
  external, suppressing spurious dynamic fan-out on untyped receivers
  ([2a3ae9f](https://github.com/artk0de/TeaRAGs-MCP/commit/2a3ae9f),
  [66c57b4](https://github.com/artk0de/TeaRAGs-MCP/commit/66c57b4))
- fix: YARD @return facts scoped to enclosing class; @!attribute-owned @return
  no longer leaks to the next unrelated method
  ([a913793](https://github.com/artk0de/TeaRAGs-MCP/commit/a913793),
  [a400d8f](https://github.com/artk0de/TeaRAGs-MCP/commit/a400d8f))
- fix: structuredReturnTypes and ivarTypes wired from TypeFactStore into
  resolve-time CallContext, activating the precise multi-hop type-propagation
  paths ([b796f89](https://github.com/artk0de/TeaRAGs-MCP/commit/b796f89))
- fix: Ruby call resolution precision: inherited method ancestor walk when class
  file unresolved, core/gem-typed receivers classified external, singleton-class
  mixin ancestors populated, runtime-hook super classified external without
  fabrication, bare-call prefers instance form, typeable chain receivers
  deferred to chainType strategy
  ([7803390](https://github.com/artk0de/TeaRAGs-MCP/commit/7803390),
  [29f7359](https://github.com/artk0de/TeaRAGs-MCP/commit/29f7359),
  [5706cab](https://github.com/artk0de/TeaRAGs-MCP/commit/5706cab),
  [d3b0623](https://github.com/artk0de/TeaRAGs-MCP/commit/d3b0623),
  [d601b6f](https://github.com/artk0de/TeaRAGs-MCP/commit/d601b6f),
  [ec6fcfa](https://github.com/artk0de/TeaRAGs-MCP/commit/ec6fcfa))

## [1.32.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.31.1...v1.32.0) (2026-06-24)

### trajectory

- inProjectEdgeRecall replaces resolveSuccessRate as the always-on completeness
  metric in get_index_status (resolveSuccessRate is now DEBUG-only)
  ([2039ece](https://github.com/artk0de/TeaRAGs-MCP/commit/2039ece))
- CHA cone devirtualization for Ruby and Python: polymorphic dispatch fans out
  to overriding subtypes
  ([241a560](https://github.com/artk0de/TeaRAGs-MCP/commit/241a560),
  [3a0034a](https://github.com/artk0de/TeaRAGs-MCP/commit/3a0034a),
  [f036350](https://github.com/artk0de/TeaRAGs-MCP/commit/f036350))
- class hierarchy edges persisted and normalized per file as substrate for CHA
  and blast-radius queries
  ([83b3320](https://github.com/artk0de/TeaRAGs-MCP/commit/83b3320),
  [eb31405](https://github.com/artk0de/TeaRAGs-MCP/commit/eb31405))
- Ruby @ivar field type inference: constructor-assigned types collected and fed
  into receiver resolution
  ([90036e7](https://github.com/artk0de/TeaRAGs-MCP/commit/90036e7),
  [978ec6a](https://github.com/artk0de/TeaRAGs-MCP/commit/978ec6a),
  [af0a4fc](https://github.com/artk0de/TeaRAGs-MCP/commit/af0a4fc))
- Ruby return-type binding resolution: method body return types resolve
  subsequent call receivers
  ([e5b650c](https://github.com/artk0de/TeaRAGs-MCP/commit/e5b650c),
  [0f26fb5](https://github.com/artk0de/TeaRAGs-MCP/commit/0f26fb5),
  [570174a](https://github.com/artk0de/TeaRAGs-MCP/commit/570174a))
- Ruby receiver type inference for ActiveRecord association chains, block
  params, and class-valued vars (increment B)
  ([64f6f93](https://github.com/artk0de/TeaRAGs-MCP/commit/64f6f93),
  [7a61733](https://github.com/artk0de/TeaRAGs-MCP/commit/7a61733),
  [ee2f1e2](https://github.com/artk0de/TeaRAGs-MCP/commit/ee2f1e2),
  [9b97fb7](https://github.com/artk0de/TeaRAGs-MCP/commit/9b97fb7),
  [9b0fb95](https://github.com/artk0de/TeaRAGs-MCP/commit/9b0fb95))
- Ruby DSL/dynamic/YARD resolution and poly-base edge expansion via
  per-framework vocabulary registry
  ([fd5a3b7](https://github.com/artk0de/TeaRAGs-MCP/commit/fd5a3b7),
  [cef11a4](https://github.com/artk0de/TeaRAGs-MCP/commit/cef11a4),
  [3456e28](https://github.com/artk0de/TeaRAGs-MCP/commit/3456e28),
  [954db08](https://github.com/artk0de/TeaRAGs-MCP/commit/954db08))
- index-access receivers (arr[k].method) classified as external and suppressed
  from dynamic dispatch fan-out
  ([73fa33f](https://github.com/artk0de/TeaRAGs-MCP/commit/73fa33f),
  [c21fc94](https://github.com/artk0de/TeaRAGs-MCP/commit/c21fc94),
  [47ac9bd](https://github.com/artk0de/TeaRAGs-MCP/commit/47ac9bd))
- dynamic send(var) counted as unresolvable instead of a resolver miss, keeping
  the denominator honest
  ([f70ae96](https://github.com/artk0de/TeaRAGs-MCP/commit/f70ae96),
  [046c5bb](https://github.com/artk0de/TeaRAGs-MCP/commit/046c5bb))
- registry-literal dispatch: CONST[k].new.method edges resolved for Ruby
  dispatch-table idioms
  ([1a01fca](https://github.com/artk0de/TeaRAGs-MCP/commit/1a01fca))
- dynamic receiver kind split into ivar/chain/index sub-buckets for targeted
  precision measurement
  ([f0b50e0](https://github.com/artk0de/TeaRAGs-MCP/commit/f0b50e0))
- external-library and gem calls excluded from codegraph resolve rate
  ([fcef101](https://github.com/artk0de/TeaRAGs-MCP/commit/fcef101))
- symbol→covering-chunk ID stored on cg_symbols so find_symbol can locate
  collapsed-class methods via two-hop fallback
  ([acabb67](https://github.com/artk0de/TeaRAGs-MCP/commit/acabb67),
  [e4ce2d3](https://github.com/artk0de/TeaRAGs-MCP/commit/e4ce2d3),
  [3beb400](https://github.com/artk0de/TeaRAGs-MCP/commit/3beb400),
  [0fd66bb](https://github.com/artk0de/TeaRAGs-MCP/commit/0fd66bb))
- prepended modules walked in Ruby self/super MRO resolution
  ([70b10e5](https://github.com/artk0de/TeaRAGs-MCP/commit/70b10e5))
- Ruby accessor methods synthesized for
  attribute/attachments/class_attribute/store_accessor macros
  ([29eb2d1](https://github.com/artk0de/TeaRAGs-MCP/commit/29eb2d1),
  [5ecc572](https://github.com/artk0de/TeaRAGs-MCP/commit/5ecc572))
- per-receiver-kind resolve instrumentation with method edge_kind and confidence
  persisted to cg_run_stats
  ([58cc525](https://github.com/artk0de/TeaRAGs-MCP/commit/58cc525),
  [70af7e8](https://github.com/artk0de/TeaRAGs-MCP/commit/70af7e8),
  [df00c27](https://github.com/artk0de/TeaRAGs-MCP/commit/df00c27))
- fix: explicit self.<member> calls now resolve via enclosing-class MRO walk
  ([4a1248e](https://github.com/artk0de/TeaRAGs-MCP/commit/4a1248e))
- fix: CHA cone hierarchy snapshot threaded into resolve context — cone dispatch
  was producing zero edges in production
  ([9dfe811](https://github.com/artk0de/TeaRAGs-MCP/commit/9dfe811))
- fix: increment B receiver-type sets pruned of merge/.to_h/.to_json false
  positives ([a418e6e](https://github.com/artk0de/TeaRAGs-MCP/commit/a418e6e))
- fix: extractOneFile materializes AST after parse for deterministic incremental
  codegraph path
  ([d743780](https://github.com/artk0de/TeaRAGs-MCP/commit/d743780))

### ingest

- poison-pill quarantine: files that crash indexing are isolated, retried on
  reindex, and their count surfaced in get_index_status
  ([0a7b04c](https://github.com/artk0de/TeaRAGs-MCP/commit/0a7b04c),
  [a7928f1](https://github.com/artk0de/TeaRAGs-MCP/commit/a7928f1),
  [6e4570b](https://github.com/artk0de/TeaRAGs-MCP/commit/6e4570b))
- embed-phase quarantine isolation: oversized or rejected chunks no longer abort
  the entire embedding pass
  ([791c499](https://github.com/artk0de/TeaRAGs-MCP/commit/791c499))
- index-codebase CLI command with live progress streaming and enrichment waiting
  ([355c472](https://github.com/artk0de/TeaRAGs-MCP/commit/355c472))
- filesCount populated from the persisted distinct-paths stat in
  get_index_status
  ([e8b1533](https://github.com/artk0de/TeaRAGs-MCP/commit/e8b1533))
- fix: quarantine durability across snapshot swaps and reindex retry path
  corrected (3 bugs found by live MCP test)
  ([9d4dce5](https://github.com/artk0de/TeaRAGs-MCP/commit/9d4dce5))
- fix: clear_index removes quarantine and stats sibling files so stale
  quarantines do not persist
  ([f94e1c0](https://github.com/artk0de/TeaRAGs-MCP/commit/f94e1c0))
- fix: codegraphEnabled persisted in project registry so tea-rags prime applies
  the correct signal set
  ([249863b](https://github.com/artk0de/TeaRAGs-MCP/commit/249863b))
- fix: enrichment progress bars use correct denominator and unit (chunks vs
  files) across all phases
  ([ab36584](https://github.com/artk0de/TeaRAGs-MCP/commit/ab36584),
  [6c3f479](https://github.com/artk0de/TeaRAGs-MCP/commit/6c3f479),
  [ca7a189](https://github.com/artk0de/TeaRAGs-MCP/commit/ca7a189),
  [5a65f7e](https://github.com/artk0de/TeaRAGs-MCP/commit/5a65f7e),
  [ca2f336](https://github.com/artk0de/TeaRAGs-MCP/commit/ca2f336),
  [ac25994](https://github.com/artk0de/TeaRAGs-MCP/commit/ac25994),
  [641bc40](https://github.com/artk0de/TeaRAGs-MCP/commit/641bc40))

### cli

- live progress bars for index-codebase — embedding and enrichment phases with
  per-phase timing, ETA, and --json output
  ([6e35dfe](https://github.com/artk0de/TeaRAGs-MCP/commit/6e35dfe),
  [eb4c81b](https://github.com/artk0de/TeaRAGs-MCP/commit/eb4c81b),
  [16c19ac](https://github.com/artk0de/TeaRAGs-MCP/commit/16c19ac),
  [446e47e](https://github.com/artk0de/TeaRAGs-MCP/commit/446e47e))
- tea-rags doctor --quarantine renders quarantine list as a human table or
  --json for agent triage
  ([21a101d](https://github.com/artk0de/TeaRAGs-MCP/commit/21a101d))
- fix: progress bar ETA uses observed throughput rate; bars freeze on
  completion; --json mode keeps stdout clean
  ([272356b](https://github.com/artk0de/TeaRAGs-MCP/commit/272356b),
  [275ddba](https://github.com/artk0de/TeaRAGs-MCP/commit/275ddba),
  [a70183f](https://github.com/artk0de/TeaRAGs-MCP/commit/a70183f),
  [add671b](https://github.com/artk0de/TeaRAGs-MCP/commit/add671b))
- fix: index size reports actual disk usage (blocks×512) and resolves versioned
  Qdrant collection paths correctly
  ([5c89e76](https://github.com/artk0de/TeaRAGs-MCP/commit/5c89e76),
  [0ef3d59](https://github.com/artk0de/TeaRAGs-MCP/commit/0ef3d59))

### codegraph

- chunker workers feed FileExtraction to codegraph — one parse serves both chunk
  storage and call-graph extraction
  ([64a2785](https://github.com/artk0de/TeaRAGs-MCP/commit/64a2785),
  [25c8418](https://github.com/artk0de/TeaRAGs-MCP/commit/25c8418))
- TypeScript CHA cone-dispatch engine wired (TSConeTypeLocator) for polymorphic
  TS call resolution
  ([8657fcc](https://github.com/artk0de/TeaRAGs-MCP/commit/8657fcc))
- per-language grain for cg_run_stats resolve summary
  ([3727cd1](https://github.com/artk0de/TeaRAGs-MCP/commit/3727cd1))
- position-aware localBindings and Ruby RHS expansion for flow-sensitive type
  inference ([5e707d0](https://github.com/artk0de/TeaRAGs-MCP/commit/5e707d0))
- fix: deterministic resolve metrics: run-state reset, cross-batch dedup,
  per-collection serialization, and spill ordering all corrected
  ([8a9c592](https://github.com/artk0de/TeaRAGs-MCP/commit/8a9c592),
  [bfba7e9](https://github.com/artk0de/TeaRAGs-MCP/commit/bfba7e9),
  [b1c1d3a](https://github.com/artk0de/TeaRAGs-MCP/commit/b1c1d3a),
  [2b20110](https://github.com/artk0de/TeaRAGs-MCP/commit/2b20110),
  [d2563d2](https://github.com/artk0de/TeaRAGs-MCP/commit/d2563d2))

### chunker

- chunker workers run as child processes — process-isolated tree-sitter parsing
  eliminates parallel parse corruption
  ([1f3c029](https://github.com/artk0de/TeaRAGs-MCP/commit/1f3c029),
  [7022b7e](https://github.com/artk0de/TeaRAGs-MCP/commit/7022b7e),
  [60d2cd1](https://github.com/artk0de/TeaRAGs-MCP/commit/60d2cd1),
  [1ff870a](https://github.com/artk0de/TeaRAGs-MCP/commit/1ff870a))
- Ruby walker emits inheritance edges with full kind parity
  (super/include/extend/prepend) with per-kind ordinals
  ([7db0b24](https://github.com/artk0de/TeaRAGs-MCP/commit/7db0b24))
- TS walker captures class extends, implements, and interface-extends into
  unified inheritanceEdges
  ([47766ed](https://github.com/artk0de/TeaRAGs-MCP/commit/47766ed))
- fix: AST materialized eagerly after parse for deterministic walker extraction
  (rdv7d root cause resolved)
  ([bbe75bb](https://github.com/artk0de/TeaRAGs-MCP/commit/bbe75bb),
  [e66135d](https://github.com/artk0de/TeaRAGs-MCP/commit/e66135d),
  [f906fb8](https://github.com/artk0de/TeaRAGs-MCP/commit/f906fb8))

### explore

- find_symbol resolves collapsed-class methods via two-hop codegraph fallback
  (symbol_id → chunk_id → getPoint)
  ([3c607ad](https://github.com/artk0de/TeaRAGs-MCP/commit/3c607ad),
  [1c06c37](https://github.com/artk0de/TeaRAGs-MCP/commit/1c06c37))

### rerank

- codegraph composites and graph tools (get_callers, get_callees, find_cycles,
  blast-radius) integrated across plugin skills
  ([97a0da3](https://github.com/artk0de/TeaRAGs-MCP/commit/97a0da3))
- fix: codegraph nested-symbols payload shape resolved in raw signal paths so
  adaptive bounds are now active
  ([213abeb](https://github.com/artk0de/TeaRAGs-MCP/commit/213abeb))
- fix: similarity min-max normalized per result batch so preset weights
  calibrate consistently across tools
  ([f6342b1](https://github.com/artk0de/TeaRAGs-MCP/commit/f6342b1))

### signals

- percent display-format hint on prime signal thresholds
  (codegraph.chunk.pageRank, git.\*.bugFixRate)
  ([9b4d2dc](https://github.com/artk0de/TeaRAGs-MCP/commit/9b4d2dc))
- fix: FanOutPerLineSignal denominator uses the real chunk line span instead of
  a phantom payload field
  ([766922a](https://github.com/artk0de/TeaRAGs-MCP/commit/766922a))
- fix: squash-mode chunk bugFixRate counts fix sessions (not raw commits),
  keeping the rate in [0, 100]
  ([7486a26](https://github.com/artk0de/TeaRAGs-MCP/commit/7486a26))
- fix: KnowledgeSiloSignal uses piecewise-linear scoring for blended contributor
  counts ([61e5b00](https://github.com/artk0de/TeaRAGs-MCP/commit/61e5b00))
- fix: PathRiskSignal matches path tokens instead of raw substrings, eliminating
  false positives on common words
  ([8fe01df](https://github.com/artk0de/TeaRAGs-MCP/commit/8fe01df))

### api

- codegraphResolve gains exactEdgeRatio edge-kind breakdown and
  per-receiver-kind inProjectEdgeRecall in get_index_status
  ([f018e95](https://github.com/artk0de/TeaRAGs-MCP/commit/f018e95),
  [167d850](https://github.com/artk0de/TeaRAGs-MCP/commit/167d850))
- IndexStatus extended with indexSizeBytes, enrichmentMetrics, and projectName
  fields ([8cb1586](https://github.com/artk0de/TeaRAGs-MCP/commit/8cb1586))

### mcp

- tea-rags:report-issue skill guides users through filing GitHub issues with
  mandatory known-issue dedup
  ([91edb07](https://github.com/artk0de/TeaRAGs-MCP/commit/91edb07))
- per-receiver-kind resolve breakdown added to get_index_status (DEBUG-gated)
  ([42bb424](https://github.com/artk0de/TeaRAGs-MCP/commit/42bb424))

### contracts

- ExternalVocabulary interface and generic ExternalCallClassifier engine for
  cross-language external-call classification
  ([18fa4b1](https://github.com/artk0de/TeaRAGs-MCP/commit/18fa4b1))
- AstNode type and materializeTree eager single-pass boundary primitive
  ([aa7253c](https://github.com/artk0de/TeaRAGs-MCP/commit/aa7253c))
- hierarchy graph types: HierarchyView, InheritanceEdge, InheritanceKind,
  HierarchySnapshot
  ([8b8d058](https://github.com/artk0de/TeaRAGs-MCP/commit/8b8d058))
- SymbolChunkResolver and GraphFacade.resolveSymbolChunk for symbol-to-chunk
  lookup ([fab7c01](https://github.com/artk0de/TeaRAGs-MCP/commit/fab7c01),
  [532ba33](https://github.com/artk0de/TeaRAGs-MCP/commit/532ba33))
- fix: withReadHandle close behavior reverted; resolveSymbolChunk test mock
  corrected ([e72cb1f](https://github.com/artk0de/TeaRAGs-MCP/commit/e72cb1f))

### adapters

- hierarchy read queries: getSubtypes, getSupertypes, transitive CTE, bulk
  snapshot, and inheritance edge persistence
  ([0f60f88](https://github.com/artk0de/TeaRAGs-MCP/commit/0f60f88),
  [63c3fe4](https://github.com/artk0de/TeaRAGs-MCP/commit/63c3fe4))

### pipeline

- pluggable WorkerTransport interface with ThreadTransport and ProcessTransport
  implementations
  ([f912b2f](https://github.com/artk0de/TeaRAGs-MCP/commit/f912b2f),
  [3636f5a](https://github.com/artk0de/TeaRAGs-MCP/commit/3636f5a))

### embedding

- primary and fallback ollama endpoints probed and surfaced independently in
  prime digest
  ([59593a2](https://github.com/artk0de/TeaRAGs-MCP/commit/59593a2))

### config

- chunker pool default restored to min(4, cpus-1) now that process isolation
  makes parallel parsing safe
  ([f190873](https://github.com/artk0de/TeaRAGs-MCP/commit/f190873))

### migration

- cg_symbols_inheritance table with bidirectional reverse indexes for class
  hierarchy edges
  ([3e252fa](https://github.com/artk0de/TeaRAGs-MCP/commit/3e252fa))

### language

- ActiveRecord association and scope declares added to Rails DSL module (single
  source for chunker and codegraph)
  ([64086d7](https://github.com/artk0de/TeaRAGs-MCP/commit/64086d7))

### infra

- MapHierarchyView: in-memory sync bidirectional view over hierarchy snapshot
  with MRO-ordered traversal
  ([6ea3aa3](https://github.com/artk0de/TeaRAGs-MCP/commit/6ea3aa3))

### presets

- fix: dead chunkChurn weight removed from file-level securityAudit and
  ownership presets where it always scored zero
  ([1f2631a](https://github.com/artk0de/TeaRAGs-MCP/commit/1f2631a))

## [1.31.1](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.31.0...v1.31.1) (2026-06-06)

### ci

- fix: release changelog workflow uses headless claude CLI to support release
  event triggers
  ([2453abe](https://github.com/artk0de/TeaRAGs-MCP/commit/2453abe))

## [1.31.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.30.0...v1.31.0) (2026-06-06)

### ci

- post-release workflow generates declarative changelogs grouped by domain, with
  fix: markers, release date headers, and dual-format rendering
  ([b54076c](https://github.com/artk0de/TeaRAGs-MCP/commit/b54076c))

## [1.30.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.29.0...v1.30.0) (2026-06-06)

### api

- trace_path tool — bounded-frontier BFS that traces execution paths between two
  symbols, with DTOs, MCP registration (gated by codegraph.symbols),
  codegraph-disabled fallback, batch payload hydration, and a config-driven
  curated rerank preset
  ([022cb50](https://github.com/artk0de/TeaRAGs-MCP/commit/022cb50),
  [859734c](https://github.com/artk0de/TeaRAGs-MCP/commit/859734c),
  [cb74047](https://github.com/artk0de/TeaRAGs-MCP/commit/cb74047),
  [8ac8a1c](https://github.com/artk0de/TeaRAGs-MCP/commit/8ac8a1c),
  [063c679](https://github.com/artk0de/TeaRAGs-MCP/commit/063c679),
  [b3a17f7](https://github.com/artk0de/TeaRAGs-MCP/commit/b3a17f7),
  [12b008c](https://github.com/artk0de/TeaRAGs-MCP/commit/12b008c),
  [5c962af](https://github.com/artk0de/TeaRAGs-MCP/commit/5c962af),
  [0977346](https://github.com/artk0de/TeaRAGs-MCP/commit/0977346))
- fix: pass exact limit to trace_path step hydration
  ([fd63ee7](https://github.com/artk0de/TeaRAGs-MCP/commit/fd63ee7))

### codegraph

- TypeScript same-file symbol resolution pass added to the resolver chain
  (position 8)
  ([2c6dcd9](https://github.com/artk0de/TeaRAGs-MCP/commit/2c6dcd9),
  [57396a3](https://github.com/artk0de/TeaRAGs-MCP/commit/57396a3))
- Ruby file- and chunk-level graph edges from zeitwerk constants, registry
  constant-literals, and `delegate ... to:` targets
  ([82a375b](https://github.com/artk0de/TeaRAGs-MCP/commit/82a375b),
  [6fc24de](https://github.com/artk0de/TeaRAGs-MCP/commit/6fc24de),
  [1f786ec](https://github.com/artk0de/TeaRAGs-MCP/commit/1f786ec))

### rerank

- annotate-only mode (reorder:false) attaches ranking overlays while preserving
  the input order
  ([7a7db0d](https://github.com/artk0de/TeaRAGs-MCP/commit/7a7db0d))

### mcp

- pathPattern scope filter for find_cycles
  ([266cd3c](https://github.com/artk0de/TeaRAGs-MCP/commit/266cd3c))

### cli

- colored informative table for tea-rags projects
  ([0a16095](https://github.com/artk0de/TeaRAGs-MCP/commit/0a16095))

### prime

- fix: default prime path to cwd when no path/project is given
  ([d35f137](https://github.com/artk0de/TeaRAGs-MCP/commit/d35f137))

### skills

- 4 codegraph sub-patterns added to tea-rags:explore, plus a project
  auto-registration step in the setup wizard
  ([771ecb8](https://github.com/artk0de/TeaRAGs-MCP/commit/771ecb8),
  [d5e71d3](https://github.com/artk0de/TeaRAGs-MCP/commit/d5e71d3))

## [1.29.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.28.0...v1.29.0) (2026-06-05)

### config

- Codegraph enrichment is now opt-in (beta), disabled by default
  ([d654c3f](https://github.com/artk0de/TeaRAGs-MCP/commit/d654c3f))
- ESLint dependency-direction guard enforces the full layer-direction matrix
  ([3ca1f7f](https://github.com/artk0de/TeaRAGs-MCP/commit/3ca1f7f))

### ingest

- Policy-skipped files are reported as ignoredFiles, separate from missedFiles
  ([9ca0f07](https://github.com/artk0de/TeaRAGs-MCP/commit/9ca0f07))
- Per-file enrichment policy: files with scope=none are excluded from file-level
  enrichment, chunk-churn is skipped for non-full scopes, and an enrichmentScope
  helper bridges classification with shouldEnrich
  ([b075d56](https://github.com/artk0de/TeaRAGs-MCP/commit/b075d56),
  [b534c2c](https://github.com/artk0de/TeaRAGs-MCP/commit/b534c2c),
  [727b8ff](https://github.com/artk0de/TeaRAGs-MCP/commit/727b8ff))
- fix: Enrichment policy is honored on backfill, recovery, and the unenriched
  count ([7e49de6](https://github.com/artk0de/TeaRAGs-MCP/commit/7e49de6))
- fix: Pre-reindex recovery is awaited so degraded markers clear before the run
  ([f507414](https://github.com/artk0de/TeaRAGs-MCP/commit/f507414))
- fix: Enrichment writes are retried with residual backfill and aligned
  unenriched filters
  ([605ca82](https://github.com/artk0de/TeaRAGs-MCP/commit/605ca82))
- fix: Heartbeat covers the full enrichment tail — applier apply-site, git
  chunk-churn drain, post-embedding enrichment, and deferred codegraph — so long
  enrichment is no longer false-flagged as stalled
  ([db88bb1](https://github.com/artk0de/TeaRAGs-MCP/commit/db88bb1),
  [9be7401](https://github.com/artk0de/TeaRAGs-MCP/commit/9be7401),
  [97f3805](https://github.com/artk0de/TeaRAGs-MCP/commit/97f3805),
  [5c3e428](https://github.com/artk0de/TeaRAGs-MCP/commit/5c3e428))
- fix: Git enrichment runs inline in-process, reverting the worker-pool affinity
  path that was slower live
  ([42a53a5](https://github.com/artk0de/TeaRAGs-MCP/commit/42a53a5))
- fix: matchedFiles counts unique paths instead of double-counting across
  enrichment passes
  ([17a72cb](https://github.com/artk0de/TeaRAGs-MCP/commit/17a72cb))
- fix: Chunk-enrichment duration is reported as wall-clock per run, resetting
  each run instead of accumulating across the daemon lifetime
  ([41f9a14](https://github.com/artk0de/TeaRAGs-MCP/commit/41f9a14),
  [08b1440](https://github.com/artk0de/TeaRAGs-MCP/commit/08b1440))
- fix: Git enrichment is pinned per-collection to restore blame/churn reuse
  ([a8d2ec4](https://github.com/artk0de/TeaRAGs-MCP/commit/a8d2ec4))
- fix: Enrichment markers are terminal-only with runId staleness tracking
  ([a93e3db](https://github.com/artk0de/TeaRAGs-MCP/commit/a93e3db))
- fix: Codegraph daemon is kept alive across the whole index run
  ([fbc2aeb](https://github.com/artk0de/TeaRAGs-MCP/commit/fbc2aeb))
- fix: Stateless work no longer steals an affinity-pinned ThreadPool thread
  ([6fe3490](https://github.com/artk0de/TeaRAGs-MCP/commit/6fe3490))
- fix: Per-provider enrichment is decoupled so all four enrichment kinds run in
  parallel ([01be8a6](https://github.com/artk0de/TeaRAGs-MCP/commit/01be8a6))
- fix: Codegraph DuckDB files are deleted on alias-swap and Qdrant
  orphan-collection cleanup, sweeping ancient orphans
  ([263573d](https://github.com/artk0de/TeaRAGs-MCP/commit/263573d),
  [0117819](https://github.com/artk0de/TeaRAGs-MCP/commit/0117819))
- fix: Non-serializable concurrencySemaphore is stripped before crossing into
  the enrichment worker
  ([4cf30a7](https://github.com/artk0de/TeaRAGs-MCP/commit/4cf30a7))
- fix: Reindex version is derived from Qdrant rather than the snapshot
  ([f45a424](https://github.com/artk0de/TeaRAGs-MCP/commit/f45a424))
- fix: Ollama health probe is retried before a fatal abort
  ([566fa8f](https://github.com/artk0de/TeaRAGs-MCP/commit/566fa8f))
- Unified enrichment worker pool: WorkerPoolEnrichmentExecutor with affinity
  routing and release is the production default, with a worker entry/protocol
  carrying a provider cache and a releaseCollection seam, wiring
  workerDescriptor for git and codegraph providers
  ([bbeba70](https://github.com/artk0de/TeaRAGs-MCP/commit/bbeba70),
  [5f61b11](https://github.com/artk0de/TeaRAGs-MCP/commit/5f61b11),
  [88e1d9a](https://github.com/artk0de/TeaRAGs-MCP/commit/88e1d9a),
  [603d142](https://github.com/artk0de/TeaRAGs-MCP/commit/603d142),
  [11cfb61](https://github.com/artk0de/TeaRAGs-MCP/commit/11cfb61))
- Streaming per-batch enrichment with no prefetch gate: deferred-provider
  extraction is driven in streaming, unmatched files are stamped, and codegraph
  chunk enrichment is deferred
  ([e2b44ab](https://github.com/artk0de/TeaRAGs-MCP/commit/e2b44ab),
  [bba7673](https://github.com/artk0de/TeaRAGs-MCP/commit/bba7673))

### trajectory

- shouldEnrich policy: codegraph treats generated and test files as none; git
  treats generated as none and docs as file-only
  ([80c6e5c](https://github.com/artk0de/TeaRAGs-MCP/commit/80c6e5c),
  [2bf832b](https://github.com/artk0de/TeaRAGs-MCP/commit/2bf832b))
- Codegraph enrichment supports a worker-pool seam with onRelease, and a git
  provider factory produces a serializable GitWorkerConfig
  ([0afa57a](https://github.com/artk0de/TeaRAGs-MCP/commit/0afa57a),
  [6f914fc](https://github.com/artk0de/TeaRAGs-MCP/commit/6f914fc))
- Codegraph streaming extraction with file-only finalizeSignals and a leak fix,
  plus git streamFileBatch with empty finalizeSignals
  ([b1f6228](https://github.com/artk0de/TeaRAGs-MCP/commit/b1f6228),
  [cee85b1](https://github.com/artk0de/TeaRAGs-MCP/commit/cee85b1))

### infra

- File-classification single source of truth via classify()
  ([64b28ff](https://github.com/artk0de/TeaRAGs-MCP/commit/64b28ff))

### contracts

- FileClassification, EnrichmentScope, and shouldEnrich are part of the contract
  surface ([012a686](https://github.com/artk0de/TeaRAGs-MCP/commit/012a686))
- EnrichmentProvider gains worker-pool lifecycle (WorkerEnrichmentDescriptor,
  onRelease, releaseCollection inline no-op) and streaming hooks
  (streamFileBatch, finalizeSignals)
  ([11cfb61](https://github.com/artk0de/TeaRAGs-MCP/commit/11cfb61),
  [8d37a12](https://github.com/artk0de/TeaRAGs-MCP/commit/8d37a12),
  [88c6cb3](https://github.com/artk0de/TeaRAGs-MCP/commit/88c6cb3))
- Per-language capability interfaces and a LanguageChunkClassifier capability
  with ChunkDecision, plus SymbolIdComposer and language-domain kernel
  ([2b94e17](https://github.com/artk0de/TeaRAGs-MCP/commit/2b94e17),
  [6503d32](https://github.com/artk0de/TeaRAGs-MCP/commit/6503d32),
  [f82cbec](https://github.com/artk0de/TeaRAGs-MCP/commit/f82cbec))

### api

- api/public is widened into the single consumer facade for core access
  ([77d79ab](https://github.com/artk0de/TeaRAGs-MCP/commit/77d79ab))

### language

- A real LanguageFactory replaces the legacy adapter map; the dormant
  legacyAdapter is introduced and later removed
  ([951e3a0](https://github.com/artk0de/TeaRAGs-MCP/commit/951e3a0))

### registry

- fix: Prime registry-first override propagates to the embedding factory
  ([56e9757](https://github.com/artk0de/TeaRAGs-MCP/commit/56e9757))
- fix: Embedding endpoints are tracked and both URLs surface in the prime digest
  ([42f445e](https://github.com/artk0de/TeaRAGs-MCP/commit/42f445e))
- fix: Stale project aliases are detected and the alias is renamed on
  re-register ([63d9be2](https://github.com/artk0de/TeaRAGs-MCP/commit/63d9be2))

### hooks

- fix: Full tool_input is preserved in Agent PreToolUse updatedInput
  ([a48b7de](https://github.com/artk0de/TeaRAGs-MCP/commit/a48b7de))

### chunker

- Ruby DSL catalogue provides a single class-body declaration vocabulary,
  deriving chunk groups; static symbols are emitted for macros inside class <<
  self singleton_class
  ([2a938a8](https://github.com/artk0de/TeaRAGs-MCP/commit/2a938a8),
  [1912126](https://github.com/artk0de/TeaRAGs-MCP/commit/1912126),
  [2d0189a](https://github.com/artk0de/TeaRAGs-MCP/commit/2d0189a))
- Language-agnostic ChunkClassifier: JS and Go chunk classifiers (with
  Receiver#Method via goSymbolOf) sit behind a shared LanguageChunkClassifier
  capability ([53441d4](https://github.com/artk0de/TeaRAGs-MCP/commit/53441d4),
  [58cfadc](https://github.com/artk0de/TeaRAGs-MCP/commit/58cfadc))
- fix: Object.defineProperty getters/setters are extracted in the JS walker
  ([d04eb56](https://github.com/artk0de/TeaRAGs-MCP/commit/d04eb56))
- fix: Abstract class methods are extracted as chunks
  ([8d26612](https://github.com/artk0de/TeaRAGs-MCP/commit/8d26612))

### codegraph

- DuckDB daemon as the default write path: wire protocol with newline-JSON
  framing, request dispatch with daemon-side graph analysis, socket proxy,
  mode-aware GraphDbClientPool acquireRead/acquireWrite, READ_ONLY access mode,
  bootstrap wiring with spawn-on-demand, and finalizeReindex deletes superseded
  version DBs after alias swap
  ([d709727](https://github.com/artk0de/TeaRAGs-MCP/commit/d709727),
  [4a97b24](https://github.com/artk0de/TeaRAGs-MCP/commit/4a97b24),
  [7d15dda](https://github.com/artk0de/TeaRAGs-MCP/commit/7d15dda),
  [b9bc374](https://github.com/artk0de/TeaRAGs-MCP/commit/b9bc374),
  [9b4a81b](https://github.com/artk0de/TeaRAGs-MCP/commit/9b4a81b),
  [4f5d81f](https://github.com/artk0de/TeaRAGs-MCP/commit/4f5d81f),
  [fb07c3e](https://github.com/artk0de/TeaRAGs-MCP/commit/fb07c3e),
  [e2804e3](https://github.com/artk0de/TeaRAGs-MCP/commit/e2804e3),
  [877c175](https://github.com/artk0de/TeaRAGs-MCP/commit/877c175),
  [be57cba](https://github.com/artk0de/TeaRAGs-MCP/commit/be57cba),
  [d60573b](https://github.com/artk0de/TeaRAGs-MCP/commit/d60573b))
- fix: Daemon releases its DuckDB lock on idle (per-collection client cache +
  bounded shutdown) and proxies the full GraphDbClient surface
  (getCallers/getCallees/findCycles) ensuring the daemon is up on reads
  ([4bb5e77](https://github.com/artk0de/TeaRAGs-MCP/commit/4bb5e77),
  [4464ad8](https://github.com/artk0de/TeaRAGs-MCP/commit/4464ad8),
  [43c624c](https://github.com/artk0de/TeaRAGs-MCP/commit/43c624c))
- fix: Per-collection symbolTable is cached in the daemon write path
  ([a32b553](https://github.com/artk0de/TeaRAGs-MCP/commit/a32b553))
- fix: Graph read path resolves the alias to the active versioned collection
  ([baf6ecf](https://github.com/artk0de/TeaRAGs-MCP/commit/baf6ecf))
- Multi-target dispatch resolves through lookup tables
  ([d60573b](https://github.com/artk0de/TeaRAGs-MCP/commit/d60573b),
  [44b29a5](https://github.com/artk0de/TeaRAGs-MCP/commit/44b29a5))
- fix: Same-file bound-type method resolves correctly on cross-file type-name
  collision ([5ae7cec](https://github.com/artk0de/TeaRAGs-MCP/commit/5ae7cec))
- Cross-language call resolution: Python inherited methods via base-class walk,
  self.field cross-method calls and stdlib external targets; Go
  var/receiver/local-var types and function-return-bound vars; Java
  parameter/field/local-var types and java.lang static auto-import; Rust
  localBindings and struct field types; TS named import specifiers and typed
  function parameters
  ([df2e19b](https://github.com/artk0de/TeaRAGs-MCP/commit/df2e19b),
  [959725e](https://github.com/artk0de/TeaRAGs-MCP/commit/959725e),
  [608e28e](https://github.com/artk0de/TeaRAGs-MCP/commit/608e28e),
  [e8fda06](https://github.com/artk0de/TeaRAGs-MCP/commit/e8fda06),
  [7ed1afa](https://github.com/artk0de/TeaRAGs-MCP/commit/7ed1afa),
  [18027ff](https://github.com/artk0de/TeaRAGs-MCP/commit/18027ff),
  [b33d239](https://github.com/artk0de/TeaRAGs-MCP/commit/b33d239),
  [6d6c4ab](https://github.com/artk0de/TeaRAGs-MCP/commit/6d6c4ab),
  [743171f](https://github.com/artk0de/TeaRAGs-MCP/commit/743171f),
  [5ab7d75](https://github.com/artk0de/TeaRAGs-MCP/commit/5ab7d75),
  [2b37bd7](https://github.com/artk0de/TeaRAGs-MCP/commit/2b37bd7))
- Codegraph trajectory is wired into validation, overlay, dampening, metrics,
  and projection, with stats.labels, connectionCount, and instability
  confidence; payload signals are exposed via typed filter params and
  get_callers/get_callees/find_cycles accept project/collection params
  ([3427f9e](https://github.com/artk0de/TeaRAGs-MCP/commit/3427f9e),
  [fcb0261](https://github.com/artk0de/TeaRAGs-MCP/commit/fcb0261),
  [973620c](https://github.com/artk0de/TeaRAGs-MCP/commit/973620c),
  [dbdec9e](https://github.com/artk0de/TeaRAGs-MCP/commit/dbdec9e))
- fix: Bare payload inner keys are written and Qdrant payload indexes created so
  codegraph filter paths resolve, with isHub computed against collection p95 at
  index time ([772b6fb](https://github.com/artk0de/TeaRAGs-MCP/commit/772b6fb),
  [078778a](https://github.com/artk0de/TeaRAGs-MCP/commit/078778a),
  [8337b13](https://github.com/artk0de/TeaRAGs-MCP/commit/8337b13))
- fix: Derived signals are read from the nested Qdrant payload shape
  ([34f886a](https://github.com/artk0de/TeaRAGs-MCP/commit/34f886a))

### qdrant

- fix: Embedded daemon is re-resolved on reconnect instead of attach-only
  ([8222198](https://github.com/artk0de/TeaRAGs-MCP/commit/8222198))

### git

- fix: Blame fields are owned-copied and blameByRelPath is released after chunk
  enrichment ([4cf151f](https://github.com/artk0de/TeaRAGs-MCP/commit/4cf151f))

### adapters

- Codegraph daemon lifecycle: paths, file refcount, and idle watcher
  ([7d15dda](https://github.com/artk0de/TeaRAGs-MCP/commit/7d15dda))
- fix: Per-collection symbolTable is cached in the daemon write path
  ([a32b553](https://github.com/artk0de/TeaRAGs-MCP/commit/a32b553))

### duckdb

- fix: Write-connection memory_limit is capped (default 2GB) with verification
  that it applied
  ([ab85e67](https://github.com/artk0de/TeaRAGs-MCP/commit/ab85e67))

### explore

- fix: find_symbol outline preserves the codegraph section and perLanguage stats
  ([ae55b29](https://github.com/artk0de/TeaRAGs-MCP/commit/ae55b29))

## [1.28.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.27.0...v1.28.0) (2026-05-24)

### codegraph

- Cross-language call graph extraction with polyglot walkers for TypeScript,
  JavaScript, Python, Ruby (Zeitwerk-aware), Go, Java, Rust, and Bash, plus a
  universal entryPoint composite
  ([fc44110](https://github.com/artk0de/TeaRAGs-MCP/commit/fc44110),
  [15b2dde](https://github.com/artk0de/TeaRAGs-MCP/commit/15b2dde),
  [9e73e14](https://github.com/artk0de/TeaRAGs-MCP/commit/9e73e14),
  [1e48a37](https://github.com/artk0de/TeaRAGs-MCP/commit/1e48a37))
- Ruby resolver understands inheritance and mixin walks, DSL macros (attr\_\*,
  AR associations, send/&block, delegate, habtm, define_method), class << self
  class methods, and local type tracking via constructors, AR finders, and YARD;
  Rails db/schema.rb excluded from the graph
  ([84544fc](https://github.com/artk0de/TeaRAGs-MCP/commit/84544fc),
  [25165c5](https://github.com/artk0de/TeaRAGs-MCP/commit/25165c5),
  [5d80031](https://github.com/artk0de/TeaRAGs-MCP/commit/5d80031),
  [6061115](https://github.com/artk0de/TeaRAGs-MCP/commit/6061115),
  [3170ec4](https://github.com/artk0de/TeaRAGs-MCP/commit/3170ec4),
  [61e03f2](https://github.com/artk0de/TeaRAGs-MCP/commit/61e03f2))
- Per-collection DB pool, streaming NDJSON spill, layered ignore handling, and
  Python type inference
  ([e8d96a5](https://github.com/artk0de/TeaRAGs-MCP/commit/e8d96a5))
- Symbol graph persisted to DuckDB with lazy hydration, backed by an in-memory
  GlobalSymbolTable and a SymbolsTrajectory with L1 family factory
  ([9eb3a84](https://github.com/artk0de/TeaRAGs-MCP/commit/9eb3a84),
  [f2b2002](https://github.com/artk0de/TeaRAGs-MCP/commit/f2b2002),
  [7160efe](https://github.com/artk0de/TeaRAGs-MCP/commit/7160efe))
- TypeScript CallResolver resolves calls through tsconfig path mapping
  ([9e73e14](https://github.com/artk0de/TeaRAGs-MCP/commit/9e73e14))
- find_cycles MCP tool detects cyclic dependencies via Tarjan SCC over file and
  method graphs
  ([0968694](https://github.com/artk0de/TeaRAGs-MCP/commit/0968694))
- PageRank method-graph signal exposed via the cg_symbols_metrics table
  ([d87f45c](https://github.com/artk0de/TeaRAGs-MCP/commit/d87f45c))
- transitiveImpact file signal computed through depth-capped reverse BFS
  ([0b8b7a1](https://github.com/artk0de/TeaRAGs-MCP/commit/0b8b7a1))
- Seven codegraph derived signals plus a blastRadius preset for graph-aware
  reranking ([f29cce9](https://github.com/artk0de/TeaRAGs-MCP/commit/f29cce9))
- CodegraphEnrichmentProvider produces file and chunk signals into the
  enrichment sink
  ([ec1c75d](https://github.com/artk0de/TeaRAGs-MCP/commit/ec1c75d))
- Codegraph wired end-to-end with env-driven CODEGRAPH_ENABLED through
  composition and bootstrap
  ([4dfa101](https://github.com/artk0de/TeaRAGs-MCP/commit/4dfa101))
- fix: Go methods are qualified and unsafe short-name fallbacks dropped in the
  Go and Java resolvers
  ([14a31a0](https://github.com/artk0de/TeaRAGs-MCP/commit/14a31a0))
- fix: classFieldTypes and classAncestors stored as Record (not Map) so they
  survive NDJSON spill
  ([8d417ee](https://github.com/artk0de/TeaRAGs-MCP/commit/8d417ee),
  [53620c7](https://github.com/artk0de/TeaRAGs-MCP/commit/53620c7),
  [fd472f0](https://github.com/artk0de/TeaRAGs-MCP/commit/fd472f0))
- fix: Zeitwerk dispatch prefers Class.method over Class#method, walks ancestors
  for Class.method calls, and matches qualified type names against the scope
  tail ([f19ee51](https://github.com/artk0de/TeaRAGs-MCP/commit/f19ee51),
  [a02d49e](https://github.com/artk0de/TeaRAGs-MCP/commit/a02d49e),
  [24ffb0e](https://github.com/artk0de/TeaRAGs-MCP/commit/24ffb0e))
- fix: classAncestors aggregated globally across all files in the pass-1 to
  pass-2 transition
  ([0c16cf8](https://github.com/artk0de/TeaRAGs-MCP/commit/0c16cf8))
- fix: End-to-end live MCP codegraph integration on tea-rags with chunk metric
  rename ([886cc4e](https://github.com/artk0de/TeaRAGs-MCP/commit/886cc4e))
- Comprehensive multi-language corner-case fixes across JS, Python, Go, Java,
  and Rust ([7476636](https://github.com/artk0de/TeaRAGs-MCP/commit/7476636))

### chunker

- TypeScript extraction walker emits file-level symbols
  ([1e48a37](https://github.com/artk0de/TeaRAGs-MCP/commit/1e48a37))

### sync

- File deletions routed through EnrichmentCoordinator before reaching Qdrant,
  with a handleDeletedPaths hook on EnrichmentProvider and coordinator dispatch
  ([3cd0bab](https://github.com/artk0de/TeaRAGs-MCP/commit/3cd0bab),
  [d32ea83](https://github.com/artk0de/TeaRAGs-MCP/commit/d32ea83))

### api

- Codegraph slice 1 exposed through App methods, a GraphFacade, and MCP tools
  ([be952e3](https://github.com/artk0de/TeaRAGs-MCP/commit/be952e3))

### presets

- Composite trajectory preset namespace with D4 overrides and an
  architecturalHub preset for codegraph-aware reranking; blastRadius moved into
  it ([ec6db7c](https://github.com/artk0de/TeaRAGs-MCP/commit/ec6db7c),
  [6156b6c](https://github.com/artk0de/TeaRAGs-MCP/commit/6156b6c))

### metrics

- Per-provider EnrichmentMetrics including codegraph extraction stats
  ([7d4cafb](https://github.com/artk0de/TeaRAGs-MCP/commit/7d4cafb))

### adapters

- DuckDB graph adapter with a migration runner and cg_symbols schema
  ([d22edce](https://github.com/artk0de/TeaRAGs-MCP/commit/d22edce))

### skills

- fix: DSL test-chunker language list corrected to include Ruby
  ([f943ae7](https://github.com/artk0de/TeaRAGs-MCP/commit/f943ae7))

## [1.27.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.26.0...v1.27.0) (2026-05-19)

### tea-rags

- The extract-project-patterns recipe skill surfaces battle-tested reference
  code as templates via a three-level locality cascade
  ([cc88140](https://github.com/artk0de/TeaRAGs-MCP/commit/cc88140))

### rerank

- The ProvenPreset ranking strategy is now available to the find_similar tool
  ([e992ebd](https://github.com/artk0de/TeaRAGs-MCP/commit/e992ebd))

## [1.26.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.25.1...v1.26.0) (2026-05-17)

### chunker

- TypeScript test-spec files are split into per-spec searchable chunks via a
  dedicated test DSL chunking hook, with an orchestrator claim invariant
  ensuring each node is captured exactly once
  ([577e1f5](https://github.com/artk0de/TeaRAGs-MCP/commit/577e1f5))

### tea-rags

- Test specs are available as first-class generation context through a
  tests-as-context skill and DSL test-chunk integration
  ([6dbeb1a](https://github.com/artk0de/TeaRAGs-MCP/commit/6dbeb1a))
- fix: Spec-extraction recipe resolves examples through semantic_search instead
  of find_symbol, returning the intended chunks
  ([14aa725](https://github.com/artk0de/TeaRAGs-MCP/commit/14aa725))

### skills

- Agents can invoke dedicated filter-building and analytics-rerank skills
  directly ([999d810](https://github.com/artk0de/TeaRAGs-MCP/commit/999d810))

### api

- fix: The path argument is optional for search_code and index_codebase, and the
  fs.watch-based test is no longer flaky
  ([0dde42b](https://github.com/artk0de/TeaRAGs-MCP/commit/0dde42b))

### hooks

- fix: The plugin-version-bump check is skipped on merge commits, so merges no
  longer fail the hook
  ([2724330](https://github.com/artk0de/TeaRAGs-MCP/commit/2724330))

### tests

- fix: Git-filter and limit assertion drifts plus embedded-Qdrant cascade and
  smoke-run drifts are resolved; the suite is green
  ([98d814f](https://github.com/artk0de/TeaRAGs-MCP/commit/98d814f),
  [a8dd218](https://github.com/artk0de/TeaRAGs-MCP/commit/a8dd218))

## [1.25.1](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.25.0...v1.25.1) (2026-05-15)

### scripts

- fix: Changelog generation escapes curly braces so the output is safe to render
  as MDX ([84d4b2d](https://github.com/artk0de/TeaRAGs-MCP/commit/84d4b2d))

### website

- fix: The documentation site builds successfully again after the 1.25.0 release
  ([db27a3d](https://github.com/artk0de/TeaRAGs-MCP/commit/db27a3d))

## [1.25.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.24.0...v1.25.0) (2026-05-15)

### project registry

- A named-alias project registry lets every project-aware tool and CLI command
  target an indexed codebase by short alias instead of an absolute path
  ([c44c9e4](https://github.com/artk0de/TeaRAGs-MCP/commit/c44c9e4),
  [3a5cd53](https://github.com/artk0de/TeaRAGs-MCP/commit/3a5cd53),
  [e7d0397](https://github.com/artk0de/TeaRAGs-MCP/commit/e7d0397),
  [0c79cc8](https://github.com/artk0de/TeaRAGs-MCP/commit/0c79cc8),
  [7f004e3](https://github.com/artk0de/TeaRAGs-MCP/commit/7f004e3),
  [a6f4d83](https://github.com/artk0de/TeaRAGs-MCP/commit/a6f4d83),
  [fdf85d1](https://github.com/artk0de/TeaRAGs-MCP/commit/fdf85d1),
  [d4ae2b1](https://github.com/artk0de/TeaRAGs-MCP/commit/d4ae2b1),
  [73f726d](https://github.com/artk0de/TeaRAGs-MCP/commit/73f726d),
  [bb05095](https://github.com/artk0de/TeaRAGs-MCP/commit/bb05095),
  [4ed4d12](https://github.com/artk0de/TeaRAGs-MCP/commit/4ed4d12))
- MCP exposes register_project, unregister_project, and list_projects tools,
  with project marked as the RECOMMENDED way to address a codebase across tool
  descriptions
  ([4c4da0a](https://github.com/artk0de/TeaRAGs-MCP/commit/4c4da0a),
  [7147f0e](https://github.com/artk0de/TeaRAGs-MCP/commit/7147f0e),
  [6d59ff2](https://github.com/artk0de/TeaRAGs-MCP/commit/6d59ff2),
  [5eb2389](https://github.com/artk0de/TeaRAGs-MCP/commit/5eb2389),
  [2fc456c](https://github.com/artk0de/TeaRAGs-MCP/commit/2fc456c))
- A `tea-rags projects` command group manages aliases: register, list, orphans,
  and unregister --purge, replacing the former flat project-\* commands
  ([8dbc43a](https://github.com/artk0de/TeaRAGs-MCP/commit/8dbc43a),
  [ac84fa2](https://github.com/artk0de/TeaRAGs-MCP/commit/ac84fa2),
  [35ae60c](https://github.com/artk0de/TeaRAGs-MCP/commit/35ae60c),
  [ed52ec9](https://github.com/artk0de/TeaRAGs-MCP/commit/ed52ec9))
- A `tea-rags doctor` command reports registry health and can recover the
  registry from Qdrant, surfacing orphans, realpath divergence, and
  missing-on-disk projects
  ([bf92a3e](https://github.com/artk0de/TeaRAGs-MCP/commit/bf92a3e),
  [da99ae7](https://github.com/artk0de/TeaRAGs-MCP/commit/da99ae7),
  [2df7a9f](https://github.com/artk0de/TeaRAGs-MCP/commit/2df7a9f))
- CollectionRegistry persists atomically with inode+mtime CAS merge-on-write,
  rejects malformed entries, backs up corrupt files, and runs through a
  migration framework
  ([e7d0397](https://github.com/artk0de/TeaRAGs-MCP/commit/e7d0397),
  [3a5cd53](https://github.com/artk0de/TeaRAGs-MCP/commit/3a5cd53),
  [3235ca4](https://github.com/artk0de/TeaRAGs-MCP/commit/3235ca4),
  [fdf2c7c](https://github.com/artk0de/TeaRAGs-MCP/commit/fdf2c7c),
  [cfafc57](https://github.com/artk0de/TeaRAGs-MCP/commit/cfafc57))
- The registry cache invalidates via fs.watch on the data directory, kept live
  by a watcher started in the MCP server bootstrap context
  ([0e515fe](https://github.com/artk0de/TeaRAGs-MCP/commit/0e515fe),
  [828b4d9](https://github.com/artk0de/TeaRAGs-MCP/commit/828b4d9))
- Shell tab-completion resolves --project alias values (bash/zsh), with fish
  completion auto-installed via postinstall when fish is detected
  ([5a0082b](https://github.com/artk0de/TeaRAGs-MCP/commit/5a0082b),
  [0f161d1](https://github.com/artk0de/TeaRAGs-MCP/commit/0f161d1))
- Typed validation errors cover project registry input, including
  ProjectPathMissingError, a shared PROJECT_NAME_RE constant, and
  RegistryConcurrencyError
  ([0c79cc8](https://github.com/artk0de/TeaRAGs-MCP/commit/0c79cc8),
  [f61e9d7](https://github.com/artk0de/TeaRAGs-MCP/commit/f61e9d7),
  [d84180e](https://github.com/artk0de/TeaRAGs-MCP/commit/d84180e))
- fix: Registry orphan detection excludes aliased physical collections and
  aligns the doctor orphan count with the projects orphans alias filter
  ([5a0a1c7](https://github.com/artk0de/TeaRAGs-MCP/commit/5a0a1c7),
  [da5ea1f](https://github.com/artk0de/TeaRAGs-MCP/commit/da5ea1f))
- fix: register_project recovers teaRagsVersion and indexedAt from the
  indexing-marker, and enrichment reads embeddingModel from the marker rather
  than a random chunk
  ([9268dd8](https://github.com/artk0de/TeaRAGs-MCP/commit/9268dd8),
  [24b9310](https://github.com/artk0de/TeaRAGs-MCP/commit/24b9310))

### signals

- Signals carry a unified SignalConfidence declaration (with
  ConfidenceClampRule) that drives both score dampening and confidence-aware
  label resolution through the reranker, with bugFixRate opting in
  ([9384f65](https://github.com/artk0de/TeaRAGs-MCP/commit/9384f65),
  [51fe043](https://github.com/artk0de/TeaRAGs-MCP/commit/51fe043),
  [e888558](https://github.com/artk0de/TeaRAGs-MCP/commit/e888558),
  [3af8695](https://github.com/artk0de/TeaRAGs-MCP/commit/3af8695))
- Percentile thresholds for confidence resolve lazily at rerank time,
  recomputing only the specific missing percentiles, backed by
  percentilesToCompute and validateSignalDependencies
  ([fa080a1](https://github.com/artk0de/TeaRAGs-MCP/commit/fa080a1),
  [80490ce](https://github.com/artk0de/TeaRAGs-MCP/commit/80490ce))
- fix: BugFixSignal dampening keeps adaptive-percentile precedence over the
  static floor
  ([acac56c](https://github.com/artk0de/TeaRAGs-MCP/commit/acac56c))
- fix: Sibling support values for confidence clamping are read from the raw
  payload ([c781803](https://github.com/artk0de/TeaRAGs-MCP/commit/c781803))

### api

- The embedded Qdrant daemon auto-spawns when no Qdrant URL is provided, and
  register_project takes a rename-only fast path that skips Qdrant for
  already-populated entries
  ([c5ef73f](https://github.com/artk0de/TeaRAGs-MCP/commit/c5ef73f),
  [620df09](https://github.com/artk0de/TeaRAGs-MCP/commit/620df09))

### cli

- fix: Tab-completion fires correctly through the yargs fallback-fn protocol
  with per-option file completion and suppressed noise on --name register
  ([b36333b](https://github.com/artk0de/TeaRAGs-MCP/commit/b36333b),
  [5b5d26b](https://github.com/artk0de/TeaRAGs-MCP/commit/5b5d26b))

## [1.24.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.23.2...v1.24.0) (2026-05-12)

### cli

- `tea-rags update` subcommand auto-updates the installed package, checking the
  npm registry for newer versions and surfacing available updates in the prime
  digest ([005b388](https://github.com/artk0de/TeaRAGs-MCP/commit/005b388),
  [fa8913e](https://github.com/artk0de/TeaRAGs-MCP/commit/fa8913e),
  [bdba841](https://github.com/artk0de/TeaRAGs-MCP/commit/bdba841),
  [6665896](https://github.com/artk0de/TeaRAGs-MCP/commit/6665896),
  [fb73433](https://github.com/artk0de/TeaRAGs-MCP/commit/fb73433),
  [55c4b79](https://github.com/artk0de/TeaRAGs-MCP/commit/55c4b79),
  [1c7a4f7](https://github.com/artk0de/TeaRAGs-MCP/commit/1c7a4f7),
  [5269984](https://github.com/artk0de/TeaRAGs-MCP/commit/5269984),
  [a563a9b](https://github.com/artk0de/TeaRAGs-MCP/commit/a563a9b))
- `tea-rags prime` produces a session digest covering indexing status, schema
  drift, polyglot detection, signal thresholds, infra-health, enrichment,
  stale-index warnings, file count, and embedding model
  ([5fd5557](https://github.com/artk0de/TeaRAGs-MCP/commit/5fd5557),
  [10b9cfb](https://github.com/artk0de/TeaRAGs-MCP/commit/10b9cfb),
  [545cb61](https://github.com/artk0de/TeaRAGs-MCP/commit/545cb61),
  [853673d](https://github.com/artk0de/TeaRAGs-MCP/commit/853673d),
  [9e7c1c4](https://github.com/artk0de/TeaRAGs-MCP/commit/9e7c1c4),
  [3ac46f9](https://github.com/artk0de/TeaRAGs-MCP/commit/3ac46f9),
  [6a1da1e](https://github.com/artk0de/TeaRAGs-MCP/commit/6a1da1e),
  [06724dd](https://github.com/artk0de/TeaRAGs-MCP/commit/06724dd),
  [90df058](https://github.com/artk0de/TeaRAGs-MCP/commit/90df058))
- fix: `tea-rags update` forces postinstall to run so the updated package is
  fully provisioned
  ([b3e1e46](https://github.com/artk0de/TeaRAGs-MCP/commit/b3e1e46))
- fix: Embedded Qdrant port is discovered via daemon.port, fixing connection in
  prime when the port is non-default
  ([63de71e](https://github.com/artk0de/TeaRAGs-MCP/commit/63de71e))

### hybrid

- Hybrid search uses server-side RRF fusion in Qdrant, combining dense and
  sparse results in a single query instead of client-side merging
  ([b05b71f](https://github.com/artk0de/TeaRAGs-MCP/commit/b05b71f))

### plugin

- `/tea-rags:prime` slash command is available and the prime digest autofires on
  SessionStart and PreCompact
  ([2002097](https://github.com/artk0de/TeaRAGs-MCP/commit/2002097),
  [7d7fad6](https://github.com/artk0de/TeaRAGs-MCP/commit/7d7fad6))

### dinopowers

- An Index Freshness Protocol, backed by a shared FRESHNESS.md, keeps dinopowers
  wrappers aware of index staleness
  ([fbed0dc](https://github.com/artk0de/TeaRAGs-MCP/commit/fbed0dc))

## [1.23.2](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.23.1...v1.23.2) (2026-05-08)

### enrichment

- fix: Concurrent enrichment runs no longer corrupt each other's state: each run
  gets an isolated RunState container, overlapping prefetches are
  FIFO-serialized, and chunk-enrichment completion re-fires correctly after
  backfill ([3789a34](https://github.com/artk0de/TeaRAGs-MCP/commit/3789a34),
  [b8414ec](https://github.com/artk0de/TeaRAGs-MCP/commit/b8414ec),
  [5a85183](https://github.com/artk0de/TeaRAGs-MCP/commit/5a85183))

## [1.23.1](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.23.0...v1.23.1) (2026-05-07)

### plugin

- fix: Plugin no longer registers type:mcp_tool hooks, which were unreliable
  under Opus 4.7 timing
  ([b35170e](https://github.com/artk0de/TeaRAGs-MCP/commit/b35170e))

## [1.23.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.22.0...v1.23.0) (2026-05-07)

### ⚠ BREAKING CHANGES

- **stats:** STATS_ACCUMULATOR_KEYS.AUTHOR_COUNTS / LINE_AUTHOR_COUNTS keys were
  renamed to RECENT_AUTHOR_COUNTS / BLAME_AUTHOR_COUNTS. Any external code
  referencing the old keys must be updated. Distributions DTO gains a new
  required field topBlameAuthors.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

- **presets:** proven preset ranking shifts. Files where ownership and
  knowledgeSilo disagreed (concentrated author share with ≥3 contributors) no
  longer get penalized. Stable preset top-N also moves slightly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

- **signals:** payload field renames break existing search queries that filter
  by `git.file.dominantAuthor`, `git.file.authors`, `git.file.contributorCount`,
  or `git.chunk.contributorCount`. Schema migration applies on next
  index_codebase run; agents/skills must update to the new field names. Filter
  params `author` and `lineOwner` removed; use `recentAuthor` and `blameOwner`.

Refs spec 2026-05-06-line-based-ownership-from-blame.md (Task 7.5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

- **signals:** rerank: "ownership" returns different top-N than before. Files
  written long ago by a now-departed author who still owns the live lines now
  rank as silos correctly; files only recently fix-touched no longer falsely
  register as concentrated. Plugin heuristics that read raw ownership values
  must reindex with forceReindex=true to populate lineDominantAuthor\* fields.

Refs spec 2026-05-06-line-based-ownership-from-blame.md (Task 5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

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

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

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
  `isStarting?: () => boolean` to `daemon?: EmbeddedDaemonProbe`. Internal API
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

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

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

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

- **ingest:** IndexPipeline.indexCodebase() now throws IndexingFailedError
  instead of returning stats with status='failed'. MCP error handler already
  handles typed errors correctly.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

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

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

- **deps:** Minimum Node.js version remains 22, but .tool-versions now defaults
  to 24.14.1. Users on Node 22 are unaffected. tree-sitter dependency now
  resolves to @artk0de/tree-sitter fork with prebuilt native binaries — no
  CXXFLAGS or compilation required.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

- **enrichment:** EnrichmentInfo and ChunkEnrichmentInfo removed.
  IndexStatus.enrichment is now Record<string, EnrichmentProviderHealth>.
  IndexStatus.chunkEnrichment removed.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

- **api:** get_index_metrics signals format changed from Record<signalKey,
  SignalMetrics> to Record<language, Record<signalKey, SignalMetrics>>. Global
  stats are now under signals["global"]. Per-language stats under
  signals["typescript"] etc. Consumers must update to access signals.global
  instead of signals directly.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

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

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

- footer should not trigger major version bumps for this project. Internal data
  format changes (sparse vectors, migrations) are handled automatically and
  don't break the user-facing API.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

- INGEST_ENABLE_HYBRID now defaults to true. Existing non-hybrid collections
  auto-migrate on next reindex.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

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
