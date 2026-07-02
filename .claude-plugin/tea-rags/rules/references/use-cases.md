# Search Use Cases

By agent task. Each maps to Decision Tree branch in `search-cascade.md`.

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
| Bare symbol name          | find_symbol     | "batch_create" → direct lookup by symbolId        |
| TODO/FIXME markers        | ripgrep MCP     | Exact string match, not hybrid                    |

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

Picking a meaningful threshold for `minCommitCount`, `minAgeDays`, `maxAgeDays`?
Don't guess. Call `get_index_metrics(project: "<alias>")`, read
`signals[language][signalKey][scope].labelMap` — actual percentile-based label
boundaries for THIS codebase.

| Question                              | Field to read                                              |
| ------------------------------------- | ---------------------------------------------------------- |
| What counts as `high` churn here?     | `signals[lang]["git.file.commitCount"]["source"].labelMap` |
| What counts as `legacy` age here?     | `signals[lang]["git.file.ageDays"]["source"].labelMap`     |
| Test scope vs source scope thresholds | Same key with `scope: "test"` instead of `"source"`        |

Phrase filters in the codebase's own distribution, not fixed numbers from
another project. Full schema + `get_index_status.infraHealth` health probe:
`references/runtime-introspection.md`.

## Sugar filters

Full typed-sugar field catalog + `level: "file"` enforcement rule for time
filters (`modifiedAfter`/`Before`, `minAgeDays`/`maxAgeDays`):
**`tea-rags:filter-building`**. Invoke that skill whenever search needs a SCOPE
(language, time window, author, testFile, taskId, `minCommitCount`, doc/code
split, etc.).

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

Preflight: DSL test chunks absent if no `git.chunk.*` signal in prime digest
shows a `test:` threshold row. Then fall back to file-level `testFile: "only"`
with explicit "DSL test chunks unavailable" note. Currently only TypeScript has
a DSL test chunker — Ruby / Python / Go / others get file-level granularity
only.

## External tools (complement tea-rags)

- **Call-sites, imports, exact patterns** → ripgrep MCP (not tea-rags)
- **File structure (methods, classes)** → tree-sitter
- **Read specific lines** → Read with offset + limit (not whole file)
