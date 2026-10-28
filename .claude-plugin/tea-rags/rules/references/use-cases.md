# Search Use Cases

By agent task. Each maps to Decision Tree branch in
`tea-rags://guide/tool-choice` (skills: `tea-rags://guide/skill-choice`).

## Discovery (don't know the naming)

| Task                              | Tool (via tree)                | Example                                                |
| --------------------------------- | ------------------------------ | ------------------------------------------------------ |
| Find subsystem by description     | semantic_search                | "retry logic after failure" → retryWithBackoff         |
| Find frontend for backend concept | semantic_search × per language | "batch create jobs" → one call per language layer      |
| Find similar pattern              | find_similar                   | Found retry in cohere → find_similar → retry in ollama |

## Analytics (rerank-driven)

| Task                         | Tool + rerank                           | Example                                                |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------ |
| Where bugs hide              | semantic_search/rank_chunks + bugHunt   | "error handling in payments domain"                    |
| What to refactor first       | rank_chunks + refactoring               | pathPattern="\*\*/payments/\*\*"                       |
| Bus factor risk              | rank_chunks + ownership                 | Single dominant author areas                           |
| Hotspots                     | semantic_search + hotspots              | "payment processing", pathPattern="\*\*/payments/\*\*" |
| Most unstable code in domain | semantic_search + hotspots or custom    | pathPattern for domain scope                           |
| Recent changes for review    | semantic_search + codeReview            | maxAgeDays=7                                           |
| Fragile Silo discovery       | semantic_search + custom (recipe below) | pathPattern by domain (e.g. `**/services/**`)          |

### Recipe: Fragile Silo discovery

Surfaces files that _look_ stable but carry regression history under one author.
Full recipe + signal-confidence semantics: **`tea-rags:analytics-rerank`**
(custom weights for Fragile Silo). Pair confirmed findings with `Fragile silo`
entry in `signal-interpretation.md` for remediation.

## Exhaustive usage (need ALL references)

| Task                     | Tool (via tree)        | Example                                              |
| ------------------------ | ---------------------- | ---------------------------------------------------- |
| All callers / all usages | hybrid_search + offset | BM25 = full recall, dense = semantic context         |
| Safe to delete / rename  | hybrid_search + offset | BM25 catches exact name, dense finds indirect usages |
| Impact of change         | hybrid_search + offset | BM25 + dense finds domain and all dependents         |

## Exact symbol search

| Task                      | Tool (via tree) | Example                                           |
| ------------------------- | --------------- | ------------------------------------------------- |
| Symbol definition         | find_symbol     | "Reranker.rerank" → instant, no embedding         |
| Symbol exists?            | find_symbol     | metaOnly=true, 0 results = doesn't exist          |
| Symbol has tests?         | find_symbol     | symbol + pathPattern for test dirs, metaOnly=true |
| Symbol + semantic context | hybrid_search   | "PaymentService validate card expiration"         |
| Bare symbol name          | find_symbol     | "order_import" → direct lookup by symbolId        |
| TODO/FIXME markers        | text search     | Exact string match, not hybrid                    |

## Code context for generation

| Task                 | Tool + rerank                    | Example                                  |
| -------------------- | -------------------------------- | ---------------------------------------- |
| Find stable template | semantic_search + stable         | Low churn = proven pattern               |
| Find fresh example   | semantic_search + recent         | Latest changes = current style           |
| Assess change impact | semantic_search + custom weights | imports: 0.5, churn: 0.3, ownership: 0.2 |

## Anti-pattern / outlier detection (find_similar with only negatives)

`find_similar` accepts `negativeCode` / `negativeIds` WITHOUT positives. With
`strategy: "best_score"`, returns code MAXIMALLY UNLIKE the negatives — outliers
relative to a known bad pattern.

| Task                                  | Inputs                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| Find code unlike a known anti-pattern | `negativeCode: "<the anti-pattern>"`, `strategy: "best_score"`    |
| Outlier detection vs a cluster        | `negativeIds: [<cluster chunk IDs>]`, `strategy: "best_score"`    |
| Find code dissimilar to legacy module | `negativeCode: <legacy snippet>` + `pathPattern: "<modern area>"` |

Inverse of "find similar to X" — for novelty surfacing, refactor candidates
diverged from a deprecated pattern, or code escaping a stylistic norm.

## Project calibration (per-project thresholds)

`minCommitCount` / `minAgeDays` / `maxAgeDays` threshold → never guess, never
copy another project's numbers. Read
`tea-rags://project/<alias>/metrics?section=labelMap&language=<lang>` — this
codebase's percentile label boundaries, `source` + `test` scope. Details:
`runtime-introspection.md` "Project calibration".

## Filters

- Typed sugar fields, which time filters honor `level`
  (`minAgeDays`/`maxAgeDays` yes, `modifiedAfter`/`Before` never),
  `level: "file"` granularity → **`tea-rags:filter-building`**. Invoke whenever
  search needs SCOPE (language, time window, author, testFile, taskId,
  `minCommitCount`, doc/code split).
- Named presets `filter: { presets: "a,b" }` — catalog, syntax, gating →
  `tea-rags://guide/filters` "Named filter presets".
- **Inventory vs query rule.** Hard specific presets (panicZone,
  abandonedHotspots, …) → query-absent inventory scans, empty result valid
  (`tea-rags:risk-assessment`). Query-driven triage stays broad, no hard
  specific filter → recall (`tea-rags:bug-hunt`, `tea-rags:explore`). Hygiene
  presets (`production`/`coreLogic`) safe any mode + default population of
  risk/structural rerank presets → `rerank:"techDebt"` already excludes
  tests/docs/block; `filter: {}` clears default. Selection:
  `tea-rags:analytics-rerank`, `tea-rags:filter-building`.

## Tests as context

DSL test chunking emits two chunk types: `chunkType: "test"` (leaf-scope
`it`/`test` scenarios, inherited `beforeEach`/`beforeAll` baked into content)
and `chunkType: "test_setup"` (fixture / setup chunks). Use these for
chunk-level granularity instead of file-level `testFile: "only"` when DSL test
chunks are indexed.

| Task                                              | Tool + filter                                                                    | Skill / recipe                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| What tests describe this scenario / changed file? | `semantic_search` + `chunkType: "test"`                                          | `tea-rags:tests-as-context` / `tests-at-risk`          |
| Tests as executable spec for onboarding           | `semantic_search` + `chunkType: "test"` + behavior query                         | direct call, no recipe                                 |
| When was the test for X first added?              | `semantic_search` + `chunkType: "test"` + sort `git.chunk.ageDays` ascending     | `tea-rags:tests-as-context` / `regression-archaeology` |
| Find a proven fixture for this setup intent       | `semantic_search` + `chunkType: "test_setup"` + `rerank: "proven"`               | `tea-rags:tests-as-context` / `fixture-lookup`         |
| Flaky / unstable test sources                     | `semantic_search` + `chunkType: "test"` or `"test_setup"` + `rerank: "hotspots"` | `tea-rags:tests-as-context` / `test-flakiness`         |
| Living spec / scenario TOC for a module           | `find_symbol(relativePath:)` + raw filter `chunkType: "test"`                    | `tea-rags:tests-as-context` / `spec-extraction`        |
| Find the test for a specific symbol               | `find_symbol(symbol:)` + filter `chunkType: "test"`                              | direct call, no recipe                                 |

Preflight: DSL test chunks exist only where language `tests` tier = `high` —
SessionStart digest `## Language capability` (or
`tea-rags://project/<alias>/metrics?section=capability`; tier meaning →
`tea-rags://guide/language-capability`). Else fall back to file-level
`testFile: "only"` + note "DSL test chunks unavailable". Never restate
per-language support here.

## Outside tea-rags

Literal text only (TODO/FIXME, phrase, regex, import-path string) → text search
(Grep tool). File structure / call-sites / usages stay on tea-rags
(`find_symbol`, `hybrid_search`, graph tools) — routing:
`tea-rags://guide/tool-choice` (skills: `tea-rags://guide/skill-choice`).
