# domains/explore — read path: strategy → rerank → overlay/confidence

## Invariants

- **Vector strategies rerank under the literal presetSet `"semantic_search"`** —
  `BaseExploreStrategy#postProcess`, `SymbolSearchStrategy#postProcess` and
  `FileOutlineStrategy#postProcess`, whatever tool called. A preset reaches any
  vector-family tool iff `tools` holds `"semantic_search"`; other entries gate
  only MCP enums and `getSchemaDescriptors`. Separate: `rank_chunks`,
  `trace_path`. Why: `tools: ["find_similar"]` validates but misses
  `matchesTool` in `Reranker#resolveMode` → silent `{ similarity: 1.0 }`.
- **Scores are batch-relative, never collection-relative.**
  `computeScoreRange` + `normalizeSimilarityScore` min-max over returned
  candidates; `Reranker#computeAdaptiveBounds` takes batch p95 floored with
  collection p95. Grouped/outline results (`CodeChunkGrouper`,
  `DocChunkGrouper`, `symbol-resolve.ts#mergeChunks`) carry `score: 1.0` —
  degenerate batch, `similarity` a constant offset. Why: another
  `limit`/`filter`, or before vs after `ensureStats`, moves absolute scores and
  can reorder; compare within one response only.
- **Outline payloads are rebuilt from an explicit allowlist.**
  `CodeChunkGrouper.group`/`.groupMembers`/`.groupFile` and
  `DocChunkGrouper.group` hand-list every field (`DocChunkGrouper.mergeSection`
  spreads its head window instead); `fileGit()`/`fileCodegraph()` exist because
  `codegraph` was lost this way (tea-rags-mcp-0am0), and `DocChunkGrouper` still
  copies `git` only. Why: a new payload namespace vanishes from find_symbol with
  no type error to catch it.
- **A test scope is drawn only from `parentType: TEST_SCOPE_PARENT_TYPE`.**
  `isTestExampleChunk` (`chunk-grouping/code.ts`) is the one gate for the scope
  lines of `CodeChunkGrouper.groupFile`, the scope-id outline in
  `resolveSymbols`, and the `#partN` admission in `SymbolSearchStrategy`. Never
  infer a scope from the id shape: a scope's setup chunk under its top-level
  name and an example under its scope are both `<parent>.<name>`. Id and
  emission contract: `.claude/rules/test-spec-chunking.md`. Why: a
  pre-example-era test chunk parented to a CLASS would be outlined instead of
  merged, reversing the u74dj decision its tests pin.
- **Test setup is hydrated at ONE seam, after the page is final.**
  `BaseExploreStrategy#hydrateTestSetup` (`TestSetupHydrator`,
  `test-setup-hydration.ts`) is the last step of every content-bearing
  `postProcess` — the base one, `ScrollRankStrategy#postProcess`,
  `SymbolSearchStrategy#postProcess` — and never runs on a metaOnly answer. It
  fetches every setup chunk of the page's files in one scroll whose filter holds
  only index-served conditions (`relativePath` text pair, `chunkType` keyword),
  and gives an example the rows of each packed setup MEMBER whose scope span
  contains its start line, sliced out of the pack (`test-pack.ts#slicePack`, the
  one pack-slicing arithmetic, which `examplePackMember` also uses to answer
  find_symbol for one member of an example pack) — never a sibling packed beside
  it. Why: the index stores each scope's setup once (bd tea-rags-mcp-5xpq4), so
  an example returned without it is not runnable in the head; hydrating before
  the slice pays for results the caller never sees, and a per-strategy copy is
  the drift this seam exists to prevent. `scopeLineRanges` / `memberRowCounts` /
  `memberSymbolIds` / `memberLineRanges` are deliberately NOT payload signal
  descriptors (like `navigation`): a declared key would raise schema drift on
  every existing index, and metaOnly and `level: "file"` drop them by design.
  Their contract: `.claude/rules/test-spec-chunking.md`.
- **A `level: "file"` hit is reduced to file scope AFTER ranking, never
  before.** `FileLevelGrouper` keeps the top chunk per file with its full
  payload; `BaseExploreStrategy#shapeFileLevel` then applies
  `chunk-grouping/file-scope.ts#reduceToFileScope`, whose keep-set `fileScopeOf`
  derives from the payload signal descriptors (flat keys declaring
  `level: "file"`, plus every namespace minus its `chunk` branches). Why: rerank
  reads chunk signals for alpha-blending and `language`/`chunkType` for overlay
  labels — stripping first silently changes ranking; and an undeclared flat key
  is dropped from file hits by design.
- **A metaOnly payload is raw; its labels live only on `rankingOverlay`.**
  `post-process.ts#filterMetaOnly` and `post-process.ts#applyEssentialSignals`
  select fields and never write an overlay value into the payload, and
  `BaseExploreStrategy#applyMetaOnly` carries the hit's `rankingOverlay`
  through. Why: the overlay is keyed by bare field name while one preset's
  `overlayMask` spans trajectories, so every merge into the payload either
  misplaced a key (bd tea-rags-mcp-rtjrn put `imports` and `fanIn` under
  `git.*`) or turned a stored number into `{value, label}` at a path filters and
  `fields` address as raw.
- **Confidence is omitted, never substituted, when the score scale is unknown.**
  `confidence.ts#isUsable` demands `ScoreBackground` with `stddev > 0` and
  `sampleCount >= MIN_BACKGROUND_PAIRS` (50); only stats-cache `version: 6` has
  one, and empty results are the sole exception (`{ value: 0, label: "low" }`).
  Why: absent means "index predates the background, a reindex fills it", not
  "low" — branch on presence; a default fabricates a verdict.

- **A band's threshold is its LOWER bound, and the published vocabulary is
  filtered to the bands that can be returned.** `resolveLabel`
  (`label-resolver.ts`) seeds the result with the first band and keeps the LAST
  whose threshold the value reached, so the first band's own threshold is inert
  — it is the default for everything below the second. Both the overlay and
  `IndexMetricsQuery#buildSignalMetrics` narrow through `resolvableLabelBands`
  before use, so a name the resolver cannot emit never reaches `labelMap`; the
  tie direction itself is declared per signal (`../trajectory/CLAUDE.md`). Why:
  `formatLabelMap` (`../../../cli/prime/format.ts`) rendered this as
  `label ≤threshold`, inverting every band in the digest — `healthy ≤0%` was
  read as "healthy only at exactly 0%" when it meant "healthy below 50%", i.e.
  76% of the population, and that misreading drove a full day of hunting a
  defect in the estimator that did not exist. Bands render `<next` for the first
  and `≥own` for the rest; there is exactly one renderer, and a second one would
  reintroduce the inversion.

## Mechanics

- **`"relevance"` never reaches the reranker; similarity-only weights skip the
  stats backfill.** Live comparison in `BaseExploreStrategy` only:
  `BaseExploreStrategy#applyDefaults` drops overfetch 4→2,
  `BaseExploreStrategy#postProcess` skips `Reranker#rerank`; the twin pair in
  `post-process.ts` is DEAD code. Symbol/file-outline never guard on it — their
  weights hit `isSimilarityOnly` (checked in `Reranker#rerank`), returning
  BEFORE `ensureNeededPercentiles()`. Why: editing `post-process.ts` changes
  nothing; similarity-only skips the backfill.
- **Preset override is keyed on `(tool, name)`** —
  `rerank/presets/index.ts#resolvePresets` indexes each preset once per `tools`
  entry, composite after registry, de-duped by identity, so two objects can
  share a `name`. Why: narrowing a composite's `tools` resurrects the registry
  preset for the dropped tools, same name, other weights.

## Gotchas

- **Two silent fallbacks to similarity-only ranking.** `Reranker#resolveMode`
  returns `{ similarity: 1.0 }` on a (name, tool) miss and `rerank()` hands the
  input back untouched; `calculateScore` skips weight keys absent from `signals`
  and returns `signals.similarity` when all miss, while `buildOverlay` still
  stamps `preset: <name>`. Why: a renamed derived signal, or a preset shipped
  before its trajectory registers, yields unranked output claiming to be ranked
  — `rank_chunks` instead throws `InvalidQueryError`.
- **Bare signal names resolve first-wins.** `buildSignalKeyMap` sets a
  one-segment suffix only `if (!map.has(suffix))`, so `commitCount`/`fanIn`/
  `ageDays` bind to whichever descriptor was merged FIRST; multi-segment forms
  (`file.commitCount`, `chunk.fanIn`) always overwrite. Why: reordering
  trajectory registration, or reusing a field name, re-points every descriptor
  `sources` entry, `overlayMask` key and `SignalConfidence.support` at once.
- **The explore→ingest ESLint guard does not fire on relative imports.** Its
  zone in `eslint.config.js` lists fully-qualified globs
  (`**/domains/ingest/**`, …) while relative specifiers carry no `domains/`
  segment — live violations (the `../ingest/` imports of `reranker.ts` and
  `queries/index-metrics.ts`) with a clean lint run. Why: the linter is not the
  guard here, and tightening to bare-segment globs (as `domains/language` does)
  is a failing change today.
- **rank_chunks `order_by` keys come from the payload signal descriptors, and
  only numeric ones order.** `RankModule#resolvePayloadField` maps a source
  through `buildSignalKeyMap` to its logical key, then `toPhysicalPayloadKey`
  (`codegraph.chunk.pageRank` → `codegraph.symbols.chunk.pageRank`); a
  non-`number` descriptor (`isHub`, `isLeaf`) orders nothing and scores only the
  candidates the numeric legs pooled; a source no descriptor declares orders
  nothing. `ScrollRankStrategy` must hand `RankModule` the strategy's
  `payloadSignals`, and its `ensureIndexFn` creates an order_by index only for a
  field those descriptors declare, with the schema `payloadFieldIndexSchema`
  (`adapters/qdrant/schema-manager.ts`) derives from the declaration. Why: a
  `git.` guess for an undeclared codegraph source ordered by a phantom key —
  `hotMethod` / `criticalMethod` / `godMethod` returned `[]` (bd
  tea-rags-mcp-xf01b) — and rank_chunks indexed every guess before scrolling,
  leaving payload indexes on keys no point carries until schema-v16 dropped them
  (bd tea-rags-mcp-q34ic).

## Boundaries

- **Overlay labels need a `language` present in per-language stats — no global
  fallback.** `Reranker#applyLabelResolution` bails with no `language`, no
  `collectionStats.perLanguage` entry, or no stats for the signal. Why: doc
  chunks, low-volume and new languages show a bare number instead of
  `{ value, label }` — stats coverage, not an `overlayMask` bug.
- **The scope pick is strict too — a test-scope point reads test-scope stats or
  nothing.** `Reranker#scopedStatsFor` picks by `detectScope` and does NOT fall
  back to `source` when the test bucket is absent; the point keeps its bare
  number, exactly as an unmeasured language does. Two populations have no test
  bucket by construction: every descriptor with a single-valued
  `chunkTypeFilter` (`methodLines`, `methodDensity`, all `codegraph.chunk.*`)
  and every descriptor declaring `stats.sourceScopeOnly` (both
  `git.*.bugFixRate`). Why: `IndexMetricsQuery#buildLanguageSignals` publishes a
  `test` labelMap ONLY when that bucket exists, so a source-derived label on a
  test point names a band the advertised vocabulary does not contain — and a
  `prime` line reading `test: —` then contradicts a live overlay saying `large`.
  It is also the collapse this file's floors bullet already refuses to cause:
  test files are systematically longer, so grading them on the source ladder
  pushes most of them into the top label whether floors are applied or not. A
  cross-scope fallback lived here until 2026-09-22 and was asserted by a test
  named for it.
- **The support axis refuses the same way.** `Reranker#meetsSupportFloor` gates
  a signal declaring `stats.minSupportPercentile`: the unit's support sibling is
  read at the signal's OWN level out of `collectScopeSiblings`, compared against
  the `SignalStats.supportFloor` the SAMPLER resolved, and a unit below it — or
  one carrying no support value at all — keeps the bare number. Never recompute
  that floor here; the sampler persists it precisely so both halves describe one
  population, and a locally-derived number would diverge the first time a
  percentile moved. Three yes-without-comparing answers are deliberate: no gate
  declared, no floor in the stats file (sampled before the declaration, so its
  bands cover everything), or no support named. Why the gate exists at all is a
  measurement, and it lives once, in `../trajectory/CLAUDE.md`.
- **Mass-signal thresholds are floored per language:
  `threshold = max(percentile, floor)`, source scope only.** `moduleLines` /
  `moduleMethodCount` / `memberCount` pass through `applySignalFloors`
  (`explore/signal-floors.ts`), keyed by LABEL name from
  `domains/language/<lang>/signal-floors.ts` (TS `moduleLines` 300/600, Ruby
  100/250) and aggregated by `LanguageFactory#signalFloors`; a language with no
  module keeps pure percentiles, a label whose percentile was never computed is
  not invented, and test scope stays percentile-only
  (`Reranker#applyLabelResolution`). Why: percentiles are relative — a tidy
  codebase still names a p95 "god-module", a monolith's p50 sits above every
  published limit. Tests are exempt because one floor would collapse them into
  the top tier.
- **Search confidence is dense-cosine-only, by measurement.**
  `computeSearchConfidence` = 0.75 × z-score of mean result score against
  `ScoreBackground` + 0.25 × directory entropy, semantic_search only.
  hybrid_search cannot be served (RRF emits rank-shaped scores, no distance);
  find_similar separates at AUC 1.000 but on a code-query scale where the prose
  cut-points label nonsense `high`. Shape components (peak, CoV) measured AUC
  0.517/0.518, 0.482 on RRF — removed. Why: extending to hybrid_search, reusing
  those cut-points, or restoring a peak component are pre-measured dead ends.

## See also

`.claude/rules/domain-boundaries.md`, `.claude/rules/facade-discipline.md`,
`.claude/rules/deep-path-navigation.md`, `.claude/rules/rerank-presets.md`,
`.claude/rules/derived-signals.md`, `.claude/rules/signal-confidence.md`,
`strategies/CLAUDE.md`
