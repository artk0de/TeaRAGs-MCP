# domains/trajectory — signal providers: what a payload carries, what a preset may weigh or pre-filter on

`static/` and `filter-presets/` knowledge lives here; `git/` and `codegraph/`
carry their own navigators.

## Invariants

- **Derived-signal names are one namespace across ALL trajectories.**
  `TrajectoryRegistry#register` walks every registered trajectory (skipping
  self-key re-registration) and throws
  `ConfigValueInvalidError("derivedSignal.name", …)` on the first duplicate. The
  same flat namespace addresses preset `weights` keys and the MCP custom-weights
  schema. Why: a second `churn` on static or codegraph, because git proved the
  name useful, takes the server down at composition time — which is why
  codegraph coined `chunkFanIn` / `fanOutPerLine`.
- **File-scoped signals declare `stats.dedupeByFile`; callable-only signals
  declare `stats.chunkTypeFilter`.** Percentiles run over POINTS, i.e. chunks
  (`admitsChunkType`, `SignalValuesAccumulator#fileScopedDedupe` keyed
  `` `${bucket}|${signal.key}|${relPath}` ``, both in
  `ingest/infra/collection-stats.ts`). EVERY `git.file.*` and `codegraph.file.*`
  signal with stats carries the dedupe flag, as do `moduleLines` /
  `moduleMethodCount`, and `file-scope-stats-dedupe.test.ts` fails on a new
  file-scope signal that forgets it. Every `git.chunk.*` signal with stats
  carries `CALLABLE_CHUNK_TYPES` (`contracts/types/chunker.ts`), while
  `methodLines` / `methodDensity` and the codegraph chunk signals still name the
  bare `"function"`; `memberCount` deliberately declares neither
  (`static/payload-signals.ts`). Why: without dedupe a 51-chunk file casts 51
  votes in its own distribution; without the type filter block/doc/class chunks
  dilute it — `block` alone outnumbers `function` on a typical index, so a
  method's churn gets ranked against barrel re-exports and constant blocks. Both
  surface as a shifted threshold and a plausible wrong label, never as an error.

  **This invariant was ASSERTED here while seventeen signals violated it**, from
  the flag's introduction until 2026-09-22 — it was applied to the two static
  module-mass signals that motivated it and never swept across the enrichment
  trajectories. Measured cost on the live tea-rags index, per-chunk against
  per-file: `git.file.ageDays` p50 7 → 31, `git.file.fileChurnCount` p50/p95
  369/3766 → 128/994, `codegraph.file.fanOut` p95 33 → 10. The damage is not
  confined to labels: the same raw percentiles are what filter presets compare
  against and what floors the reranker's adaptive bounds, so a p95 inflated
  threefold compresses every normalized file signal and changes RANKING. A
  navigator asserting an invariant nothing enforces is worse than silence —
  hence the test.

- **When several bands share a threshold, `stats.bandTieBreak` says which name
  wins.** An atomic distribution ties neighbouring percentiles and the bands
  between them vanish; `resolvableLabelBands` (`../explore/label-resolver.ts`)
  drops the unreachable names so `resolveLabel` and the published `labelMap`
  cannot disagree. Default `"upper"` keeps the walk-and-take-the-last rule.
  `"lower"` is declared only where a MEASURED tie produced a name that is wrong
  about the code: both `bugFixRate` scopes, both `commitCount` scopes, and the
  contributor counts. Why: the right end is a property of the signal and no
  algorithm recovers it — `blameDominantAuthorPct` ties at 100 and 100%
  ownership IS a deep silo, `blameContributorCount` ties at 1 and one author is
  `solo`, `codegraph.chunk.fanIn` ties at 1 on the same shape yet one caller is
  `typical`, not `unused`. Before this existed, ripgrep and gin — every file
  stamped `bugFixRate: 25` — reported 100% of their chunks `critical`.
- **A single-valued `chunkTypeFilter` DELETES the test-scope distribution.**
  Scope detection routes `function` to the source bucket and `test` to the test
  one, so naming one value leaves the other bucket empty, `perLanguage` carries
  no `test` entry, and every test chunk falls back to a bare number with no
  label. Live tell: `methodLines`, `methodDensity` and all three
  `codegraph.chunk.*` report `test: —` in `get_index_metrics` for exactly this
  reason. A signal that wants both scopes declares both types — that is what
  `CALLABLE_CHUNK_TYPES` is.
- **A ZERO is discarded from the sample unless the signal declares
  `stats.zeroIsValidObservation`.** The same `tryPushSignalValue` drops it,
  because for most signals 0 means the producer never reached the file — a file
  past `chunkMaxFileLines` publishes `git.chunk.commitCount: 0` on every chunk,
  and `run-finalize.ts` falls back to `ZERO_FILE_METRICS` for a path its metrics
  map has no row for. A ratio inverts that: `git.*.bugFixRate` is 0 because the
  commits held no fix, which is a reading, and both bugFixRate descriptors carry
  the flag. Why: leave a real zero out and the percentiles describe P(x | x > 0)
  — every boundary sits above the population, and where the survivors are mostly
  one-commit chunks the labelMap collapses onto a single value and inverts.
  Decide it per signal; whether 0 means "measured none" or "never measured" is a
  fact about that signal's producer, so a sweep over the remaining zero-capable
  signals (`fanIn`, `fanOut`, `instability`, `churnVolatility`) would be a
  guess.
- **Filter-preset thresholds are precomputed, global, and raw-signal-only.** A
  filter preset compiles to a Qdrant PRE-filter applied during the vector
  search, before any reranker exists. So: conditions address raw payload keys
  only (`churn` / `recency` are query-relative, unfilterable);
  `{percentile, fallback}` resolves from `collectionStats.perSignal` — the
  GLOBAL map, never per-language, never the reranker's batch p95
  (`resolveThreshold` in `filter-presets/compiler.ts`); `fallback` is mandatory
  by type and cold-start only; every referenced `pN` must be declared in the
  owning descriptor's `percentilesToCompute` or `labels`, or composition throws
  (`validateSignalDependencies` in `collection-stats.ts`). Why: the lazy
  percentile recompute that rescues confidence labels runs inside
  `Reranker.rerank()` and cannot reach here — an undeclared percentile never
  backfills, it silently uses the hardcoded fallback on every query against that
  index.

## Mechanics

- **A composite preset REPLACES the provider preset of the same name — or
  vanishes.** `buildCompositePresets(registeredKeys)`
  (`composite/presets/index.ts`) keeps a composite only when every entry of its
  mandatory `requires` is a registered trajectory KEY — the codegraph key is
  `"codegraph.symbols"`, not `"codegraph"` (`decomposition` / `godModule`
  require it alone, `bugHunt` requires `["codegraph.symbols", "git"]`). A
  dropped composite falls back to the same-named provider preset, so a shadowing
  composite must repeat that preset's default `filter` or the name changes scope
  with the flag (`decomposition` lost `coreLogic` this way). The switch is
  `CODEGRAPH_ENABLED=true` (`buildEnvInputs` in `bootstrap/config/parse.ts`),
  default off. Why: `ENABLE_CODEGRAPH` exists nowhere in `src/`, and
  `requires: ["codegraph"]` gates on nothing — either literal ranks differently
  than intended, silently.
- **Every percentile is scope-split; the global aggregate is source-scope,
  code-language only.** Stats are computed per (language, scope ∈ source|test),
  and `chunkType: "test_setup"` is dropped from both (`detectScope` in
  `infra/scope-detection.ts`). The `perSignal` map that filter presets and
  dampening thresholds read accepts a point only when
  `ctx.isCodeLanguage && ctx.scope === "source"`
  (`SignalValuesAccumulator#accept`). Path-pattern test detection
  (`CODE_TEST_PATHS`, else per-language defaults) is a FALLBACK: it fires only
  where the collection holds zero `chunkType: "test"` chunks for that language
  (`detectScope`). Why: a `p75 commitCount` used as a filter threshold or
  dampening `k` is a source-code number while the filter still matches test
  chunks; and editing `CODE_TEST_PATHS` for a language whose chunker already
  emits test chunks changes nothing.
- **`RerankPreset.filter` is a default a user filter REPLACES, and `relevance`
  must never declare one.** `resolveFilterSpec`
  (`api/internal/ops/explore-ops.ts`): `effective = spec ?? presetDefault`, and
  an explicit `{}` clears the default outright. Typed params (`language`,
  `minAgeDays`, `documentation`, …) AND on top of whichever won — except that a
  DEFAULT excluding what the typed params select (tests, docs, a chunk type) is
  dropped (`presetDefaultExcludesCallerScope`, same file). Scopes that compile
  to no visible condition count too, read from the caller's params: an explicit
  `testFile` / `documentation` `"include"` and a documentation `language`
  (`DOCUMENTATION_LANGUAGES`). They fire only when passed — the search schemas
  give neither param a default. `RelevancePreset` ships no `filter`;
  `CriticalPathPreset` (`composite/presets/critical-path.ts`) ships
  `{ presets: "production" }`. Why: a preset's narrowing disappears the moment a
  caller passes any filter of their own — the two do not compose — so a default
  filter on a general-purpose preset changes every unqualified search.
- **`occur: "should"` compiles to a nested `must: [{ should: [...] }]`, never a
  top-level `should`.** `compileFilterPreset` buckets by `occur` and pushes one
  nested clause; worked example `git/filter-presets/panic-zone.ts`
  (`recencyWeightedFreq` p50 `must`, `bugFixRate` and `churnVolatility` p75 both
  `should`). Why: in Qdrant a top-level `should` beside any `must` is score-only
  and excludes nothing, so the naive form returns the unfiltered set.

## Gotchas

- **Declaring `stats.labels` does not guarantee a label.** A language reaches
  `perLanguage` only if it is in `CODE_LANGUAGES`, holds ≥ `MIN_LANGUAGE_SHARE`
  (0.05) of all chunks, and has ≥ `MIN_SAMPLE_SIZE` (10) valid values for at
  least one stats signal (`computeCollectionStats`) — config/markup languages
  never qualify. Miss a gate, or carry no `language`, and label resolution skips
  the signal: the overlay keeps the bare number. Why: the failure is an ABSENT
  label on a small-share language, not a polyglot-mixed one, and nothing falls
  back to the global distribution (`../explore/CLAUDE.md` owns the resolution
  side).
- **`payload.isTest` is a filename regex, absent when false, 16 languages.**
  `detectTestFile` (`static/test-detection.ts`) matches `basename(relativePath)`
  only, so `spec/models/user_spec.rb` hits while `tests/helpers.py` and
  `src/test/java/Helper.java` do not; the provider writes the key only on a hit
  (`StaticPayloadBuilder#buildPayload`). Why: `production` / `coreLogic` exclude
  by `isTest`, so directory-organized suites leak through them — and a condition
  written `isTest = false` matches nothing, leaving the shipped
  `{ op: "eq", value: true, occur: "must_not" }` as the only working form.

## See also

- `.claude/rules/payload-signals.md`, `.claude/rules/derived-signals.md`,
  `.claude/rules/rerank-presets.md`, `.claude/rules/signal-confidence.md`,
  `.claude/rules/imports-field-semantics.md`, `.claude/rules/migrations.md`
- `git/CLAUDE.md`, `codegraph/CLAUDE.md`, `../explore/CLAUDE.md`,
  `../ingest/CLAUDE.md`
