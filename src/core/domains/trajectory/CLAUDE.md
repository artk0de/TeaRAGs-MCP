# domains/trajectory — signal providers: what a payload carries, what a preset may weigh or pre-filter on

`static/` and `filter-presets/` knowledge lives here; `git/` and `codegraph/`
carry their own navigators.

## Invariants

- **Derived-signal names are one namespace across ALL trajectories.**
  `TrajectoryRegistry#register` (registry.ts:40-59) walks every registered
  trajectory (skipping self-key re-registration) and throws
  `ConfigValueInvalidError("derivedSignal.name", …)` on the first duplicate. The
  same flat namespace addresses preset `weights` keys and the MCP custom-weights
  schema. Why: a second `churn` on static or codegraph, because git proved the
  name useful, takes the server down at composition time — which is why
  codegraph coined `chunkFanIn` / `fanOutPerLine`.
- **File-scoped signals declare `stats.dedupeByFile`; callable-only signals
  declare `stats.chunkTypeFilter: "function"`.** Percentiles run over POINTS,
  i.e. chunks (ingest/infra/collection-stats.ts:71 filter, :130-138
  `fileScopedDedupe` keyed `` `${bucket}|${signal.key}|${relPath}` ``).
  `moduleLines` / `moduleMethodCount` carry the dedupe flag; `methodLines` /
  `methodDensity` and the codegraph chunk signals carry the type filter;
  `memberCount` deliberately declares neither (static/payload-signals.ts:38-44).
  Why: without dedupe a 51-chunk file casts 51 votes in its own distribution;
  without the type filter block/doc/class chunks dilute it. Both surface as a
  shifted threshold and a plausible wrong label, never as an error.
- **Filter-preset thresholds are precomputed, global, and raw-signal-only.** A
  filter preset compiles to a Qdrant PRE-filter applied during the vector
  search, before any reranker exists. So: conditions address raw payload keys
  only (`churn` / `recency` are query-relative, unfilterable);
  `{percentile, fallback}` resolves from `collectionStats.perSignal` — the
  GLOBAL map, never per-language, never the reranker's batch p95
  (filter-presets/compiler.ts:25-31); `fallback` is mandatory by type and
  cold-start only; every referenced `pN` must be declared in the owning
  descriptor's `percentilesToCompute` or `labels`, or composition throws
  (collection-stats.ts:418-437). Why: the lazy percentile recompute that rescues
  confidence labels runs inside `Reranker.rerank()` and cannot reach here — an
  undeclared percentile never backfills, it silently uses the hardcoded fallback
  on every query against that index.

## Mechanics

- **A composite preset REPLACES the provider preset of the same name — or
  vanishes.** `buildCompositePresets(registeredKeys)`
  (composite/presets/index.ts:100) keeps a composite only when every entry of
  its mandatory `requires` is a registered trajectory KEY — the codegraph key is
  `"codegraph.symbols"`, not `"codegraph"` (`decomposition` / `godModule`
  require it alone, `bugHunt` requires `["codegraph.symbols", "git"]`). A
  dropped composite falls back to the same-named provider preset. The switch is
  `CODEGRAPH_ENABLED=true` (bootstrap/config/parse.ts:149), default off. Why:
  `ENABLE_CODEGRAPH` exists nowhere in `src/`, and `requires: ["codegraph"]`
  gates on nothing — either literal ranks differently than intended, silently.
- **Every percentile is scope-split; the global aggregate is source-scope,
  code-language only.** Stats are computed per (language, scope ∈ source|test),
  and `chunkType: "test_setup"` is dropped from both
  (infra/scope-detection.ts:44). The `perSignal` map that filter presets and
  dampening thresholds read accepts a point only when
  `ctx.isCodeLanguage && ctx.scope === "source"` (collection-stats.ts:141).
  Path-pattern test detection (`CODE_TEST_PATHS`, else per-language defaults) is
  a FALLBACK: it fires only where the collection holds zero `chunkType: "test"`
  chunks for that language (scope-detection.ts:49-56). Why: a `p75 commitCount`
  used as a filter threshold or dampening `k` is a source-code number while the
  filter still matches test chunks; and editing `CODE_TEST_PATHS` for a language
  whose chunker already emits test chunks changes nothing.
- **`RerankPreset.filter` is a default a user filter REPLACES, and `relevance`
  must never declare one.** `resolveFilterSpec`
  (api/internal/ops/explore-ops.ts:456-459):
  `effective = spec ?? presetDefault`, and an explicit `{}` clears the default
  outright. Typed params (`language`, `minAgeDays`, `documentation`, …) AND on
  top of whichever won. `RelevancePreset` ships no `filter`;
  `composite/presets/critical-path.ts:30` ships `{ presets: "production" }`.
  Why: a preset's narrowing disappears the moment a caller passes any filter of
  their own — the two do not compose — so a default filter on a general-purpose
  preset changes every unqualified search.
- **`occur: "should"` compiles to a nested `must: [{ should: [...] }]`, never a
  top-level `should`.** compiler.ts:63-83 buckets by `occur` and pushes one
  nested clause; worked example `git/filter-presets/panic-zone.ts`
  (`recencyWeightedFreq` p50 `must`, `bugFixRate` and `churnVolatility` p75 both
  `should`). Why: in Qdrant a top-level `should` beside any `must` is score-only
  and excludes nothing, so the naive form returns the unfiltered set.

## Gotchas

- **Declaring `stats.labels` does not guarantee a label.** A language reaches
  `perLanguage` only if it is in `CODE_LANGUAGES`, holds ≥ `MIN_LANGUAGE_SHARE`
  (0.05) of all chunks, and has ≥ `MIN_SAMPLE_SIZE` (10) valid values for at
  least one stats signal (collection-stats.ts:563-575) — config/markup languages
  never qualify. Miss a gate, or carry no `language`, and label resolution skips
  the signal: the overlay keeps the bare number. Why: the failure is an ABSENT
  label on a small-share language, not a polyglot-mixed one, and nothing falls
  back to the global distribution (`../explore/CLAUDE.md` owns the resolution
  side).
- **`payload.isTest` is a filename regex, absent when false, 16 languages.**
  `detectTestFile` (static/test-detection.ts:26-31) matches
  `basename(relativePath)` only, so `spec/models/user_spec.rb` hits while
  `tests/helpers.py` and `src/test/java/Helper.java` do not; the provider writes
  the key only on a hit (static/provider.ts:33). Why: `production` / `coreLogic`
  exclude by `isTest`, so directory-organized suites leak through them — and a
  condition written `isTest = false` matches nothing, leaving the shipped
  `{ op: "eq", value: true, occur: "must_not" }` as the only working form.

## See also

- `.claude/rules/payload-signals.md`, `.claude/rules/derived-signals.md`,
  `.claude/rules/rerank-presets.md`, `.claude/rules/signal-confidence.md`,
  `.claude/rules/imports-field-semantics.md`, `.claude/rules/migrations.md`
- `git/CLAUDE.md`, `codegraph/CLAUDE.md`, `../explore/CLAUDE.md`,
  `../ingest/CLAUDE.md`
