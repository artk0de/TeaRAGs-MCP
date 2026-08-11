# domains/explore — read path: strategy → rerank → overlay/confidence

## Invariants

- **Vector strategies rerank under the literal presetSet `"semantic_search"`** —
  `#postProcess` of `BaseExploreStrategy` (strategies/base.ts:65),
  `SymbolSearchStrategy` (symbol.ts:160) and `FileOutlineStrategy`
  (file-outline.ts:80), whatever tool called. A preset reaches any vector-family
  tool iff `tools` holds `"semantic_search"`; other entries gate only MCP enums
  and `getSchemaDescriptors`. Separate: `rank_chunks`, `trace_path`. Why:
  `tools: ["find_similar"]` validates but misses `matchesTool` in
  `Reranker#resolveMode` → silent `{ similarity: 1.0 }`.
- **Scores are batch-relative, never collection-relative.**
  `computeScoreRange` + `normalizeSimilarityScore` min-max over returned
  candidates; `Reranker#computeAdaptiveBounds` takes batch p95 floored with
  collection p95. Grouped/outline results (`CodeChunkGrouper`,
  `DocChunkGrouper`, `symbol-resolve.ts#mergeChunks`) carry `score: 1.0` —
  degenerate batch, `similarity` a constant offset. Why: another
  `limit`/`filter`, or before vs after `ensureStats`, moves absolute scores and
  can reorder; compare within one response only.
- **Outline payloads are rebuilt from an explicit allowlist.**
  `CodeChunkGrouper.group`/`.groupFile` and `DocChunkGrouper.group` hand-list
  every field; `fileGit()`/`fileCodegraph()` exist because `codegraph` was lost
  this way (tea-rags-mcp-0am0), and `DocChunkGrouper` still copies `git` only.
  Why: a new payload namespace vanishes from find_symbol and every
  `level: "file"` result, with no type error to catch it.
- **Confidence is omitted, never substituted, when the score scale is unknown.**
  `confidence.ts#isUsable` demands `ScoreBackground` with `stddev > 0` and
  `sampleCount >= MIN_BACKGROUND_PAIRS` (50); only stats-cache `version: 6` has
  one, and empty results are the sole exception (`{ value: 0, label: "low" }`).
  Why: absent means "index predates the background, a reindex fills it", not
  "low" — branch on presence; a default fabricates a verdict.

## Mechanics

- **`"relevance"` never reaches the reranker; similarity-only weights skip the
  stats backfill.** Live comparison in `BaseExploreStrategy` only:
  `applyDefaults` (base.ts:46) drops overfetch 4→2, `postProcess` (base.ts:64)
  skips `Reranker#rerank`; the twin pair in `post-process.ts` is DEAD code.
  Symbol/file-outline never guard on it — their weights hit `isSimilarityOnly`
  (reranker.ts:170-172), returning BEFORE `ensureNeededPercentiles()`. Why:
  editing `post-process.ts` changes nothing; similarity-only skips the backfill.
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
  segment — live violations (reranker.ts:30, queries/index-metrics.ts:15-17)
  with a clean lint run. Why: the linter is not the guard here, and tightening
  to bare-segment globs (as `domains/language` does) is a failing change today.
- **rank_chunks `order_by` hard-codes a `git.` prefix.**
  `RankModule#resolvePayloadField` emits `` `git.${source}` `` for
  level-prefixed sources, so codegraph signals (`chunk.pageRank`, `file.fanIn`)
  resolve to non-existent paths; only dotless ones (`moduleLines`,
  `methodDensity`) survive, and nothing resolvable → `rankChunks` returns `[]`.
  Why: presets mixing codegraph signals with `"rank_chunks"` (`hotMethod`,
  `architecturalHub`) order by a phantom key, or return empty unexplained.

## Boundaries

- **Overlay labels need a `language` present in per-language stats — no global
  fallback.** `Reranker#applyLabelResolution` bails with no `language`, no
  `collectionStats.perLanguage` entry, or no stats for the signal. Why: doc
  chunks, low-volume and new languages show a bare number instead of
  `{ value, label }` — stats coverage, not an `overlayMask` bug.
- **Mass-signal thresholds are floored per language:
  `threshold = max(percentile, floor)`, source scope only.** `moduleLines` /
  `moduleMethodCount` / `memberCount` pass through `applySignalFloors`
  (signal-floors.ts:40-60), keyed by LABEL name from
  `domains/language/<lang>/signal-floors.ts` (TS `moduleLines` 300/600, Ruby
  100/250) and aggregated by `LanguageFactory#signalFloors`
  (language/factory.ts:144); a language with no module keeps pure percentiles, a
  label whose percentile was never computed is not invented, and test scope
  stays percentile-only (reranker.ts:648-655). Why: percentiles are relative — a
  tidy codebase still names a p95 "god-module", a monolith's p50 sits above
  every published limit. Tests are exempt because one floor would collapse them
  into the top tier.
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
